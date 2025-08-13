# Homebridge Naim UnitiQute 2 (UPnP)

Homebridge accessory plugin to control a Naim UnitiQute 2 (or similar Naim renderers) via UPnP/DLNA services exposed at `description.xml`.

It implements SOAP calls to:

- `RenderingControl:1` at `/RenderingControl/ctrl` (volume, mute)
- `AVTransport:1` at `/AVTransport/ctrl` (play, pause, stop, next, previous, set URI)

Discovered endpoints should look like your device's `description.xml` serviceList.

## Install

```bash
npm install -g homebridge-naim-unitiqute2
```

## Configure (UI or JSON)

Using Homebridge UI, set:

- `ipAddress` (required): e.g. `192.168.1.XXX`
- `port` (optional): default `8080`
- `name` (optional): default `Naim UnitiQute 2`
- `sources` (optional array): list of objects `{ name, uri }` to expose as inputs. `uri` should be a valid UPnP transport URI.

JSON example (`config.json`):

```json
{
  "accessories": [
    {
      "accessory": "NaimUnitiqute2",
      "name": "Naim UnitiQute 2",
      "ipAddress": "192.168.1.234",
      "port": 8080,
      "sources": [
        { "name": "Radio 1", "uri": "x-rincon-mp3radio://example.com/stream" }
      ]
    }
  ]
}
```

## Supported Controls (mapped)

- Play: `AVTransport#Play`
- Pause: `AVTransport#Pause`
- Next/Previous: `AVTransport#Next`, `AVTransport#Previous`
- Set Source: `AVTransport#SetAVTransportURI`
- Volume: `RenderingControl#SetVolume` (Master)
- Mute: `RenderingControl#SetMute` (Master)

The plugin exposes a `Television` + `TelevisionSpeaker` accessory in HomeKit:

- Active toggles Play/Pause
- Remote keys Right/Left or FF/REW map to Next/Previous
- Volume/Mute are absolute volume and mute
- If `sources` are provided, they appear as input sources

## Manual SOAP Example

```bash
curl "http://192.168.1.234:8080/RenderingControl/ctrl" \
  -H 'Content-Type: text/xml; charset="utf-8"' \
  -H 'SOAPACTION: "urn:schemas-upnp-org:service:RenderingControl:1#SetVolume"' \
  --data-binary @- <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
      <InstanceID>0</InstanceID>
      <Channel>Master</Channel>
      <DesiredVolume>25</DesiredVolume>
    </u:SetVolume>
  </s:Body>
</s:Envelope>
XML
```

## Notes

- Ensure your Naim is on the same network and exposes the UPnP endpoints (e.g., `http://IP:8080/description.xml`).
- Some sources may require metadata in `SetAVTransportURI`; the plugin currently sends an empty metadata field.
