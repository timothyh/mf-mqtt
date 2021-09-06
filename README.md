# mf-mqtt

TLDR: NodeJS Gateway between Modern Form Fans and MQTT

Fan Discovery

NOTES from other projects

https://github.com/nickbreaton/homebridge-modern-forms

From https://colinbourassa.github.io/software/modernforms/

Modern Forms fan IP control

Published: 2020-08-10

Some of the ceiling fans produced by the company Modern Forms allow remote control over IP via their built-in Wi-Fi. When first installed, the fans act as an access point and broadcast their own SSID. Users are intended to download the Modern Forms smartphone app, which is capable of configuring the fan for connecting to the user's home network (by supplying an SSID and password). The app is then capable of sending commands to control the fan speed and direction, and switch the light on or off.

I wanted the option of using this REST API, but I was not interested in using the Modern Forms app or otherwise connecting to their cloud services. The JSON-based API for fan control is fairly well understood, and this GitHub repo by user Barry Quiel (quielb) provides a Python implementation of the interface. It also has a Python package index page. However, I wasn't able to find any information about the process of configuring the fan with the user's network SSID and password in the first place, so I figured this out and have documented it here.

The first step in the process -- connecting to the fan's access point -- is partially covered by owner's manual. The fan will broadcast the SSID ModernFormsFan_XXXXXX, with the last six characters being the last hex digits from the fan's MAC address. This access point will accept connections when supplied with the password intelligence. Via DHCP, it appears to serve an address in the subnet 10.10.10.0/24, with the fan itself assuming 10.10.10.1. The client must then make an HTTP POST request to the fan with the appropriate JSON payload. It's straightforward to do this from the command line with cURL:

curl -i \
 --header "Content-Type: application/json; charset=utf-8" \
 --request POST \
 --data '{"federatedIdentity":"","owner":"","deviceName":"fan0","SSID":"your-network-name","PASSWORD":"your-network-passwd","DHCP":true,"timezone","UTC-5"}' \
  http://10.10.10.1/config-write-uap

Adjust the values of deviceName, SSID, PASSWORD, and timezone appropriately for your installation, network, and location. After receiving the request, the fan should respond with HTTP/1.1 200 OK, and then close the connection as it joins the new network.

I suspected that Modern Forms embedded code was not completely custom, but rather a commercial network stack intended for cloud-connected devices. A web search found the URL fragment config-write-uap in the config_server.c module of the MXOS stack, and this is certainly the embedded codebase used for these fans, as they identify themselves with the hostname MXCHIP when they join the network.


## References
* Slug - https://en.wikipedia.org/wiki/Clean_URL#Slug
* https://colinbourassa.github.io/software/modernforms/
* https://github.com/quielb/pypi/tree/a646c79ae73eeeb01f441afc0256a95bd8818778/modernforms
