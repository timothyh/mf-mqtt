'use strict'

const fetch = require('node-fetch')

/*
 * {
  "adaptiveLearning": false,
  "awayModeEnabled": false,
  "clientId": "MF_A8032ADD0220",
  "cloudPort": 8883,
  "decommission": false,
  "factoryReset": false,
  "fanDirection": "forward",
  "fanOn": true,
  "fanSpeed": 3,
  "fanTimer": 0,
  "lightBrightness": 100,
  "lightOn": false,
  "lightTimer": 0,
  "resetRfPairList": false,
  "rfPairModeActive": true,
  "schedule": "",
  "timezone": "EST5EDT",
  "userData": "ble",
  "wind": false,
  "windSpeed": 2
}
*/

class MFFanClient {
    constructor(ip) {
        this.ip = ip
        this.path = '/mf'
        this.client = 'http://' + this.ip + this.path
    }

    async _post(data) {
        var json

	// console.log("Post: %s", JSON.stringify(data))

        try {
            const res = await fetch(this.client, {
                method: 'POST',
                body: JSON.stringify(data)
            })
            if (!res.ok) {
                var err = new Error("Connection rejected")
                err.address = this.ip
                err.errno = res.statusText
                throw (err)
            }
            json = await res.json()
        } catch (e) {
            throw (e)
        }

        return json
    }

    async info() {
        const json = await this._post({
            queryDynamicShadowData: 1
        })

        return json
    }

    async reboot() {
        try {
            var res = await this._post({
                reboot: true
            })
        } catch (e) {}
    }

    async set(name, value) {
        const okNames = ['fanSpeed', 'fanDirection', 'lightOn', 'fanOn', 'lightBrightness', 'wind', 'windSpeed']

        for (const n of okNames) {
            if (n.toLowerCase() === name.toLowerCase()) {
                var data = {}
                data[n] = value
                const json = await this._post(data)
                return json
            }
        }
        throw new Error(`Invalid set operation ${this.client}: ${name}`)
    }

}

exports.MFFanClient = MFFanClient
