'use strict'

// Returns associative array data structure
// homeassistant_type/device_slug => homeassistant definition as associative array

// Inputs:
//   Info data structure - As taken from fan device + additional metadata
//   Bondhome MQTT topic prefix (from config file)

module.exports.hassConfig = function(info, prefix) {
    var res = {}

    var id = info.clientId
    var manu = info.manufacturer ? info.manufacturer : 'Modern Forms'
    var model = info.model ? info.model : 'N/A'
    var attr = {
        'command_topic': prefix + '/' + info.slug + '/set/fan',
        'device': {
            'identifiers': id + '-fan',
            'manufacturer': manu,
            'model': model,
            'name': info.fan_name
        },
        'name': info.name,
        'payload_off': 'off',
        'payload_on': 'on',
        'state_topic': prefix + '/' + info.slug + '/fan',
        'unique_id': id + '-fan'
    }
    attr.percentage_command_topic = prefix + '/' + info.slug + '/set/speed'
    attr.percentage_state_topic = prefix + '/' + info.slug + '/speed'
    if (info.max_speed) attr.speed_range_max = info.max_speed

    res["fan/" + info.slug] = attr

    if (info.has_light) {
        var attr = {
            'command_topic': prefix + '/' + info.slug + '/set/light',
            'device': {
                'identifiers': id + '-lit',
                'manufacturer': manu,
                'model': model,
                'name': info.light_name,
                'via_device': id + '-fan'
            },
            'name': info.name,
            'payload_off': 'off',
            'payload_on': 'on',
            'state_topic': prefix + '/' + info.slug + '/light',
            'unique_id': id + '-lit'
        }
	attr.brightness_scale = 100
	attr.brightness_command_topic = prefix + '/' + info.slug + '/set/brightness'
	attr.brightness_state_topic = prefix + '/' + info.slug + '/brightness'

        res["light/" + info.slug] = attr
    }
    return res
}
