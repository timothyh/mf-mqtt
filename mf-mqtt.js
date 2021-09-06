'use strict'

const util = require('util')
const os = require("os")
const fs = require("fs")
const mqtt = require('mqtt')
const http = require('http')
const dns = require('dns')
const stringify = require('json-stable-stringify')
const {
    getIPRange
} = require('get-ip-range')

const mh = require('./my-helpers')
const fc = require('./mf-fan-client')

var config = mh.readConfig('./config.json')

var myName = 'mf-mqtt'

var mqttConf = {
    ...config.mqtt_conf
}

util.inspect.defaultOptions.maxArrayLength = null
util.inspect.defaultOptions.depth = null

var expireIpAfter = (config.discover_expire ? mh.durationToSeconds(config.discover_expire) : (12 * 3600)) * 1000
var pollActive = config.poll_active ? config.poll_active * 1000 : 5000
var pollIdle = config.poll_idle ? config.poll_idle * 1000 : 5000
var pollRetries = config.poll_retries ? config.poll_retries : 3
var speedBoostTime = config.speed_boost_time ? config.speed_boost_time * 1000 : 0
var hostnamePrefix = config.hostname_prefix ? config.hostname_prefix : 'mf_fan_'

var hassEnabled = false
var hassStatusTopic
var hassModules = './homeassistant/'
var hassMqttOptions = {}

var verbose = mh.isTrue(config.verbose)
var debug = mh.isTrue(config.debug)

var separators = ['_', '-', '$', ':', ';', '!', '@', '#', '%', '^', '~']
var slugSeparator = '_'

var attributes = {
    'fanSpeed': {
        name: 'speed',
        type: 'number'
    },
    'fanDirection': {
        name: 'direction',
        values: ['forward', 'reverse']
    },
    'lightOn': {
        name: 'light',
        type: "bool"
    },
    'fanOn': {
        name: 'fan',
        type: "bool"
    },
    'lightBrightness': {
        name: 'brightness',
        type: "number"
    },
    'wind': {
        name: 'wind',
        type: "bool"
    },
    'windSpeed': {
        name: 'wind_speed',
        type: "number"
    }
}

var attr_rev = {}
Object.keys(attributes).forEach(function(attr) {
    attr_rev[attributes[attr].name] = attr
})

if (config.slug_separator) {
    if (!separators.includes(config.slug_separator)) {
        console.warn("Invalid slug separator: '%s'", config.slug_separator)
        process.exit(1)
    }
    slugSeparator = config.slug_separator
}
mh.setSeparator(slugSeparator)

if (mqttConf.cafile) mqttConf.cacertificate = [fs.readFileSync(mqttConf.cafile)]

// Last time an IP address responded
var ipTimestamps = {}

// Inventory of fans - Keyed by clientId
var fans = {}
// IP address to clientId mapping
var fanIps = {}
// Slug to clientId mapping
var fanSlugs = {}

var newFanRegex
var commandRegex
var setRegex
var sendRegex

if (config.homeassistant) {
    hassEnabled = mh.isTrue(config.homeassistant.discovery_enable)
    if (hassEnabled) {
        hassMqttOptions.retain = mh.isTrue(config.homeassistant.retain)
        if (config.homeassistant.status_topic) hassStatusTopic = config.homeassistant.status_topic
        if (config.homeassistant.modules) hassModules = config.homeassistant.modules + '/'
    }
}

var mqttActivity = Date.now()

function clientId2Hostname(clientId) {
    return hostnamePrefix + clientId.substring(clientId.length - 6).toLowerCase()
}

function convertValue(type, value) {
    if (type === 'bool') return mh.isTrue(value) ? 'on' : 'off'
    return value.toString()
}

function getLocalIps() {
    var ni = os.networkInterfaces()
    var res = []
    Object.keys(ni).forEach(function(iface) {
        var conf = ni[iface]
        for (var n = 0; n < conf.length; n++) {
            if (!conf[n].internal && conf[n].family === 'IPv4') res.push(conf[n].cidr)
        }
    })

    return res
}

function expandRange(range) {
    var res

    if (typeof range === 'string') {
        if (range.match(/[^0-9\.]/)) {
            res = getIPRange(range)
            // If CIDR representation remove first and last addresses
            if (range.match(/\//)) {
                res.splice(0, 1)
                res.splice(-1, 1)
            }
        } else {
            res = [range]
        }
    } else if (typeof range === 'object') {
        res = getIPRange(range[0], range[1])
    }
    return res
}

function fanSetIdlePoll(info) {
    if (info.pollInterval === pollIdle) return

    if (verbose) console.log('%s: setIdle', info.slug)
    info.pollInterval = pollIdle
    clearTimeout(info.timer)
    info.timer = setTimeout(fanCheck, 500, info)

    clearTimeout(info.pollResetTimer)
    delete info.pollResetTimer
}

function fanSetDead(info) {
    if (verbose) console.log('%s: setDead', info.slug)

    delete ipTimestamps[info.ip]

    clearTimeout(info.timer)
    delete info.timer

    clearTimeout(info.pollResetTimer)
    delete info.pollResetTimer
}

function fanSetActivePoll(info) {
    if (verbose && info.pollInterval !== pollActive) console.log('%s: setActive', info.slug)

    info.pollInterval = pollActive
    clearTimeout(info.timer)
    info.timer = setTimeout(fanCheck, 500, info)

    clearTimeout(info.pollResetTimer)
    info.pollResetTimer = setTimeout(fanSetIdlePoll, 60000, info)
}

function fanSetState(info, state) {
    if (info.state === state) return
    info.state = state
    mqttClient.publish(mqttConf.topic_prefix + '/' + info.slug + '/' + 'state', state ? 'on' : 'off')
}

function fanCheck(info) {
    clearTimeout(info.timer)

    if (ipTimestamps[info.ip]) {
        // Avoid duplicate polling threads
        if ((Date.now() - ipTimestamps[info.ip]) < info.pollInterval) {
            if (debug) console.log("%s: checked recently", info.ip)

            info.timer = setTimeout(fanCheck, info.pollInterval, info)
            return
        }
    }

    if (debug) console.log("check %s", info.slug)

    info.client.info().then(function(newinfo) {
        var active = false

        for (const attr of Object.keys(attributes)) {
            if (info[attr] !== newinfo[attr]) {
                mqttClient.publish(mqttConf.topic_prefix + '/' + info.slug + '/' + attributes[attr].name, convertValue(attributes[attr].type, newinfo[attr]))
                info[attr] = newinfo[attr]
                active = true
            }
        }
        if (active) fanSetActivePoll(info)

        info.queryFails = 0
        fanSetState(info, true)
        info.timer = setTimeout(fanCheck, info.pollInterval, info)
    }).catch(function(e) {
        info.queryFails += 1
        if (info.queryFails > pollRetries) {
            fanSetState(info, false)
            fanSetDead(info)
        } else {
            info.timer = setTimeout(fanCheck, info.pollInterval, info)
        }
    })
}

function fanInfo(ip) {
    if (ipTimestamps[ip]) {
        // Don't check if checked recently - discover_expire defines time in config
        if ((Date.now() - ipTimestamps[ip]) < expireIpAfter) {
            if (debug) console.log("%s: checked recently", ip)
            return
        }
    }

    const client = new fc.MFFanClient(ip)

    client.info().then(function(info) {
        if (debug) console.log("%s: %s", ip, info)

        if (!info) return

        ipTimestamps[ip] = Date.now()

        var oldinfo = {}
        info.clientId = info.clientId.toUpperCase()

        if (fans[info.clientId]) {
            // Copy existing configuration
            oldinfo = fans[info.clientId]
            info.name = oldinfo.name
            info.slug = oldinfo.slug
            info.fan_name = oldinfo.fan_name
            info.light_name = oldinfo.light_name
            info.hostname = oldinfo.hostname
            info.has_light = oldinfo.has_light
            info.max_speed = oldinfo.max_speed
            info.boost_on_start = oldinfo.boost_on_start
            info.type = oldinfo.type
            info.debug = oldinfo.debug
        } else {
            // New/unknown fan discovered so use default configuration
            info.name = info.clientId
            info.slug = info.clientId.toSlug()
            info.fan_name = info.name + ' Fan'
            info.light_name = info.name + ' Light'
            info.hostname = clientId2Hostname(info.clientId)
            info.has_light = true
            info.max_speed = 6
            info.boost_on_start = false
            info.type = 'MF_FAN'
            info.debug = false

            fanSlugs[info.slug] = info.clientId
        }

        fanIps[ip] = info.clientId

        fans[info.clientId] = info

        info.ip = ip
        info.client = client
        info.queryFails = 0
        info.pollInterval = 0
        info.last_log = Date.now()

        if (debug) console.log("%s: discovered: %s slug: %s", ip, info.name, info.slug)

        hassPublish(info)

        setTimeout(function() {
            fanSetState(info, true)
            for (const attr of Object.keys(attributes)) {
                mqttClient.publish(mqttConf.topic_prefix + '/' + info.slug + '/' + attributes[attr].name, convertValue(attributes[attr].type, info[attr]))
            }
        }, 2000)

        fanSetActivePoll(info)

    }).catch(function(e) {
        switch (e.errno) {
            case 'EHOSTUNREACH':
                break
            default:
                ipTimestamps[ip] = Date.now()
                if (debug) console.error(e)
                break
        }
    })
}

function mgmtCommand(topic, payload) {

    if (debug) console.log("Mgmt command topic: %s payload: %s", topic, payload)

    payload = payload.toString().toLowerCase()

    switch (payload) {
        case 'scan':
            setTimeout(fanScanAll, 100)
            break
        case 'fullscan':
            ipTimestamps = {}
            setTimeout(fanScanAll, 100)
            break
    }
}

function fanSet(topic, payload) {
    var info
    var action

    if (debug) console.log("Set topic: %s Payload: %s", topic, payload)

    payload = payload.toString()

    topic.split('/').forEach(function(word) {
        word = word.toLowerCase()
        if (fanSlugs[word]) info = fans[fanSlugs[word]]
        action = word
    })

    if (!info) {
        console.warn("Unexpected set message topic: %s payload: %s", topic, payload)
        return
    }
    if (verbose) console.log("%s: action=%s value=\"%s\"", info.slug, action, payload)
    switch (action) {
        case 'dead':
            fanSetDead(info)
            break
        case 'alive':
        case 'active':
            fanSetActivePoll(info)
            break
        case 'debug':
            info.debug = mh.isTrue(payload)
            break
        default:
            var attr = attr_rev[action]
            var value = payload
            var boost = false

            if (!attr) {
                console.warn("Unexpected set message attribute: %s payload: %s", topic, payload)
                return
            }
            switch (attributes[attr].type) {
                case 'bool':
                    value = mh.isTrue(payload)
                    break
                case 'number':
                    value = parseInt(payload)
                    break
            }
            if (action === 'speed') info.reqSpeed = value
            if (action === 'fan') boost = (value && speedBoostTime && info.boost_on_start)

            if (boost) {
                var speedAttr = attr_rev['speed']
                var speedValue = info.max_speed
                info.reqSpeed = info.fanSpeed

                if (verbose) console.log("fan speed boost slug: %s attribute: %s value: %s cur speed: %s", info.slug, speedAttr, speedValue, info.fanSpeed)
                info.client.set(speedAttr, speedValue)
                // Reset when boost time expires
                setTimeout(function() {
                    speedValue = info.reqSpeed
                    if (verbose) console.log("fan boost speed reset slug: %s attribute: %s value: %s", info.slug, speedAttr, speedValue)
                    info.client.set(speedAttr, speedValue)
                }, speedBoostTime)
            }
            if (verbose) console.log("fan set slug: %s attribute: %s value: %s", info.slug, attr, value)
            info.client.set(attr, value)
            fanSetActivePoll(info)
            break
    }

}

function fanScanAll() {
    var delay = 50

    if (config.fans) {
        Object.keys(config.fans).forEach(function(configId) {

            var clientId = configId.toUpperCase()

            if (!fans[clientId]) fans[clientId] = {}

            fans[clientId].clientId = clientId
            var name = config.fans[configId].name ? config.fans[configId].name : clientId
            fans[clientId].name = name
            var slug = config.fans[configId].slug ? config.fans[configId].slug : fans[clientId].name.toSlug()
            fans[clientId].slug = slug
            var hostname = config.fans[configId].hostname ? config.fans[configId].hostname : clientId2Hostname(clientId)
            fans[clientId].hostname = hostname

            fans[clientId].has_light = config.fans[configId].has_light === undefined ? true : config.fans[configId].has_light
            fans[clientId].fan_name = config.fans[configId].fan_name ? config.fans[configId].fan_name : fans[clientId].name + ' Fan'
            fans[clientId].light_name = config.fans[configId].light_name ? config.fans[configId].light_name : fans[clientId].name + ' Light'
            fans[clientId].max_speed = config.fans[configId].max_speed ? config.fans[configId].max_speed : 6
            fans[clientId].type = config.fans[configId].type ? config.fans[configId].type : 'MF_FAN'
            fans[clientId].boost_on_start = config.fans[configId].boost_on_start ? config.fans[configId].boost_on_start : false
            fans[clientId].debug = false

            fanSlugs[slug] = clientId

            var ip = config.fans[configId].ip

            if (ip) {
                setTimeout(fanInfo, delay, ip)
                delay += 50
                if (debug) console.log("clientId: %s name: %s slug: %s hostname: %s ip: %s", clientId, name, slug, hostname, ip)
            } else {
                dns.lookup(hostname, (err, address, family) => {
                    if (family != 4) return
                    ip = address
                    setTimeout(fanInfo, delay, ip)
                    delay += 50
                    if (debug) console.log("clientId: %s name: %s slug: %s hostname: %s ip: %s", clientId, name, slug, hostname, ip)
                })
            }
        })
    }

    var ips
    if (config.fan_ips) {
        ips = config.fan_ips
    } else {
        ips = getLocalIps()
    }

    ips.forEach(function(range) {
        try {
            if (verbose) console.log("scan ips: %s", range)

            expandRange(range).forEach(function(ip) {
                setTimeout(fanInfo, delay, ip)
                delay += 50
            })
        } catch (err) {
            console.warn('badly formed range: %s error: %s', range, util.inspect(err).replace(/\s*\n\s*/g, ' '))
        }
    })

    if (verbose) {
        setTimeout(function() {
            console.log("Scan complete")
        }, delay + 1000)
    }

    if (verbose) {
        setTimeout(function() {
            Object.keys(fans).forEach(function(clientId) {
                var info = fans[clientId]
                console.log("clientId: %s name: %s slug: %s hostname: %s ip: %s", info.clientId, info.name, info.slug, info.hostname, info.ip)
            })
        }, delay + 2000)
    }

}

//
// Process MQTT messages informing of a (potential) new Fan online
function fanAlive(topic, payload) {
    var ip

    if (config.new_fan_attribute) {
        var message
        try {
            message = JSON.parse(payload.toString())
            if (debug) console.log(topic + ': ' + util.inspect(message).replace(/\s*\n\s*/g, ' '))
            ip = message[config.new_fan_attribute]
        } catch {
            console.warn('badly formed message: ' + message.toString().replace(/\s*\n\s*/g, ' '))
            return
        }
    } else {
        ip = payload.toString()
    }
    if (verbose) console.log("New device online: %s", ip)
    delete ipTimestamps[ip]
    // Allow time for device to stabilize
    setTimeout(fanInfo, 5000, ip)
}

function hassPublishAll() {
    if (!hassEnabled) return

    console.log("Publishing homeassistant configuration")

    Object.keys(fans).forEach(function(clientId) {
        var info = fans[clientId]

        if (info) {
            hassPublish(info)

            setTimeout(function() {
                Object.keys(attributes).forEach(function(attr) {
                    mqttClient.publish(mqttConf.topic_prefix + '/' + info.slug + '/' + attributes[attr].name, convertValue(attributes[attr].type, info[attr]))
                })
            }, 2000)
        } else {
            console.warn('Unidentified fan: %s', clientId)
        }
    })
}

function hassPublish(info) {
    if (!hassEnabled) return

    var mods = []

    if (info.model) mods.push(hassModules + 'model-' + info.model.toSlug('-'))
    if (info.template) mods.push(hassModules + 'template-' + info.template.toSlug('-'))
    if (info.type) mods.push(hassModules + 'type-' + info.type.toSlug('-'))

    var hc

    for (const mod of mods) {
        console.log("Load " + mod)
        try {
            if (verbose) console.log("%s: trying to load module: %s", info.slug, mod)
            hc = require(mod)
            if (verbose) console.log("%s: loaded module: %s", info.slug, mod)
        } catch (err) {
            if (err.code !== 'MODULE_NOT_FOUND') throw (err)
        }
        if (hc) break
    }
    if (hc) {
        var res = hc.hassConfig(info, mqttConf.topic_prefix)
        for (const topic in res) {
            mqttClient.publish(config.homeassistant.topic_prefix + '/' + topic + '/config', JSON.stringify(res[topic]), hassMqttOptions)
        }
    }
}

var mqttClient = mqtt.connect({
    ca: mqttConf.cacertificate,
    host: mqttConf.host,
    port: mqttConf.port,
    username: mqttConf.username,
    password: mqttConf.password,
    protocol: mqttConf.protocol,
    keepalive: mqttConf.keepalive,
    will: config.status_topic ? {
        topic: config.status_topic,
        payload: 'stop'
    } : undefined
})

mqttClient.on('connect', function() {
    console.log("Connected to MQTT Broker")

    if (config.new_fan_topic) {
        mqttClient.subscribe(config.new_fan_topic)
        newFanRegex = mh.topicToRegex(config.new_fan_topic)
        if (debug) console.log('New Fan topic match: %s', newFanRegex)
    }

    if (config.fan_set_topic) {
        mqttClient.subscribe(config.fan_set_topic)
        setRegex = mh.topicToRegex(config.fan_set_topic)
        if (debug) console.log('Set topic match: %s', setRegex)
    }

    if (config.command_topic) {
        mqttClient.subscribe(config.command_topic)
        commandRegex = mh.topicToRegex(config.command_topic)
        if (debug) console.log('Control topic match: %s', commandRegex)
    }

    if (hassStatusTopic) mqttClient.subscribe(hassStatusTopic)

    mqttClient.subscribe(mqttConf.ping_topic)
})

mqttClient.on('close', function() {
    console.warn("MQTT connection closed")
    process.exit(1)
})

mqttClient.on('error', function(err) {
    console.warn(err)
    //process.exit(1)
})

// MQTT Keepalive
setInterval(function() {
    mqttClient.publish(mqttConf.ping_topic, JSON.stringify({
        timestamp: new Date()
    }))
}, 60000)

mqttClient.on('message', function(topic, payload) {
    mqttActivity = Date.now()

    payload = payload.toString()

    if (topic === mqttConf.ping_topic) {
        return
    }

    if (newFanRegex && topic.match(newFanRegex)) {
        if (debug) console.log("topic: %s payload: %s", topic, payload)
        fanAlive(topic, payload)
        return
    }

    if (verbose) console.log("topic: %s payload: %s", topic, payload)

    if (topic === hassStatusTopic) {
        if (payload === config.homeassistant.startup_payload) setTimeout(hassPublishAll, 30000)
        return
    } else if (setRegex && topic.match(setRegex)) {
        fanSet(topic, payload)
    } else if (commandRegex && topic.match(commandRegex)) {
        mgmtCommand(topic, payload)
    } else {
        if (debug) console.warn("Unexpected message: %s : %s", topic, payload)
    }
})

setInterval(function() {
    var mqttLast = (Date.now() - mqttActivity)
    if (mqttLast >= 90000) {
        console.warn("Exit due to MQTT inactivity")
        process.exit(10)
    }
}, 10000)

if (config.status_topic) mqttClient.publish(config.status_topic, 'start')

setTimeout(fanScanAll, 100)

if (debug) {
    setTimeout(function() {
        console.log(util.inspect(fans))
    }, 31000)
}

console.log("Starting")
