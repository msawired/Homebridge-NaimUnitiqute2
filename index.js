const axios = require('axios');

let Service, Characteristic, UUIDGen, Categories;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;
  Categories = api.hap.Categories;

  api.registerAccessory('homebridge-naim-unitiqute2', 'NaimUnitiqute2', NaimUnitiqute2Accessory);
};

class NaimUnitiqute2Accessory {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.name = config.name || 'Naim UnitiQute 2';
    this.ip = config.ipAddress;
    this.port = config.port || 8080;
    this.baseUrl = `http://${this.ip}:${this.port}`;
    this.timeouts = config.timeoutMs || 5000;
    this.sources = config.sources || []; // optional: [{ name, uri, mime? }]
    this.defaultUri = config.defaultUri || null; // optional; NOT required for resume-previous-source behavior
    // Local state cache for volume slider accessory
    this.lastVolume = 25;
    this.lastMuted = false;

    if (!this.ip) {
      this.log.warn('ipAddress not set in config. Please configure the plugin.');
    }

    // Build accessory information
    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Naim Audio')
      .setCharacteristic(Characteristic.Model, 'UnitiQute 2')
      .setCharacteristic(Characteristic.SerialNumber, 'Unknown');

    // Television service (represents the receiver)
    this.tvService = new Service.Television(this.name);
    this.tvService
      .setCharacteristic(Characteristic.ConfiguredName, this.name)
      .setCharacteristic(Characteristic.SleepDiscoveryMode, Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);

    // Active -> represents playback state; ON=Play, OFF=Pause
    this.tvService.getCharacteristic(Characteristic.Active)
      .onGet(async () => {
        try {
          const tinfo = await this.avtGetTransportInfo();
          const state = (tinfo.state || '').toUpperCase();
          return (state === 'PLAYING' || state === 'TRANSITIONING')
            ? Characteristic.Active.ACTIVE
            : Characteristic.Active.INACTIVE;
        } catch (e) {
          this.log.debug('Active onGet fallback (assuming INACTIVE):', e?.message || e);
          return Characteristic.Active.INACTIVE;
        }
      })
      .onSet(async (value) => {
        // Map directly to Play/Pause; swallow errors to avoid user-facing failures when device is unreachable
        try {
          if (value === Characteristic.Active.ACTIVE) {
            await this.avtPlay();
          } else {
            await this.avtPause();
          }
        } catch (e) {
          const code = this.parseUpnpErrorCode(e);
          this.log.debug('Active onSet Play/Pause error:', code || e?.message || e);
        }
      });

    // RemoteKey -> Next/Previous and Play/Pause
    this.tvService.getCharacteristic(Characteristic.RemoteKey)
      .onSet(async (value) => {
        try {
          switch (value) {
            case Characteristic.RemoteKey.PLAY_PAUSE: {
              const media = await this.avtGetMediaInfo();
              if (!media.currentURI) {
                this.log.debug('Remote PLAY_PAUSE: no UPnP CurrentURI; ignoring.');
                break;
              }
              const tinfo = await this.avtGetTransportInfo();
              const s = (tinfo.state || '').toUpperCase();
              if (s === 'PLAYING' || s === 'TRANSITIONING') {
                try { await this.avtPause(); } catch (e) { this.log.debug('Pause declined:', e?.message || e); }
              } else {
                try { await this.avtPlay(); } catch (e) { this.log.debug('Play declined:', e?.message || e); }
              }
              break;
            }
            case Characteristic.RemoteKey.ARROW_RIGHT:
            case Characteristic.RemoteKey.FAST_FORWARD:
              await this.avtNext();
              break;
            case Characteristic.RemoteKey.ARROW_LEFT:
            case Characteristic.RemoteKey.REWIND:
              await this.avtPrevious();
              break;
            default:
              this.log.debug('Unhandled RemoteKey:', value);
          }
        } catch (e) {
          this.log.error('Failed handling RemoteKey:', e?.message || e);
        }
      });

    // Television Speaker for volume and mute
    this.speakerService = new Service.TelevisionSpeaker(this.name + ' Speaker');
    // Clarify speaker control name in UI
    try { this.speakerService.setCharacteristic(Characteristic.Name, this.name + ' TV Speaker'); } catch {}
    this.speakerService
      .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
      .setCharacteristic(Characteristic.VolumeControlType, Characteristic.VolumeControlType.ABSOLUTE);

    this.speakerService.getCharacteristic(Characteristic.Mute)
      .onGet(() => this.lastMuted)
      .onSet(async (value) => {
        try {
          const mute = !!value;
          await this.rcSetMute(mute);
          this.lastMuted = mute;
          // Keep other UIs in sync
          try { this.volumeService.updateCharacteristic(Characteristic.On, !mute); } catch {}
          try { this.muteService && this.muteService.updateCharacteristic(Characteristic.On, mute); } catch {}
        } catch (e) {
          this.log.error('Failed to set mute:', e?.message || e);
          throw e;
        }
      });

    this.speakerService.getCharacteristic(Characteristic.Volume)
      .onSet(async (value) => {
        try {
          // HomeKit uses 0-100; UnitiQute supports 0-100 master
          await this.rcSetVolume(Number(value));
        } catch (e) {
          this.log.error('Failed to set volume:', e?.message || e);
          throw e;
        }
      });

    this.tvService.addLinkedService(this.speakerService);

    // Native Speaker service (exposes HomeKit Volume characteristic)
    // Use a unique subtype so it can co-exist with TelevisionSpeaker (same underlying UUID)
    this.hkSpeakerService = new Service.Speaker(this.name + ' Speaker Control', 'hk-speaker');
    try { this.hkSpeakerService.setCharacteristic(Characteristic.Name, 'Volume'); } catch {}
    this.hkSpeakerService
      .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE);

    this.hkSpeakerService.getCharacteristic(Characteristic.Mute)
      .onGet(() => this.lastMuted)
      .onSet(async (value) => {
        try {
          const mute = !!value;
          await this.rcSetMute(mute);
          this.lastMuted = mute;
          // Sync other controls
          try { this.speakerService.updateCharacteristic(Characteristic.Mute, mute); } catch {}
          try { this.volumeService.updateCharacteristic(Characteristic.On, !mute); } catch {}
          try { this.muteService && this.muteService.updateCharacteristic(Characteristic.On, mute); } catch {}
        } catch (e) {
          this.log.error('Failed to set mute (HK Speaker):', e?.message || e);
          throw e;
        }
      });

    this.hkSpeakerService
      .addCharacteristic(Characteristic.Volume)
      .onGet(() => this.lastVolume)
      .onSet(async (value) => {
        try {
          const vol = Math.max(0, Math.min(100, Number(value)));
          await this.rcSetVolume(vol);
          this.lastVolume = vol;
          if (vol > 0 && this.lastMuted) {
            await this.rcSetMute(false);
            this.lastMuted = false;
            // Sync across controls
            try { this.speakerService.updateCharacteristic(Characteristic.Mute, false); } catch {}
            try { this.volumeService.updateCharacteristic(Characteristic.On, true); } catch {}
            try { this.muteService && this.muteService.updateCharacteristic(Characteristic.On, false); } catch {}
          }
        } catch (e) {
          this.log.error('Failed to set volume (HK Speaker):', e?.message || e);
          throw e;
        }
      });

    // Separate Volume Slider (Lightbulb) for quick access in Home app
    // On -> not muted, Off -> muted; Brightness 0-100 -> volume level
    this.volumeService = new Service.Lightbulb(this.name + ' Volume');
    try { this.volumeService.setCharacteristic(Characteristic.Name, 'Volume'); } catch {}
    this.volumeService
      .getCharacteristic(Characteristic.On)
      .onGet(() => !this.lastMuted)
      .onSet(async (value) => {
        try {
          const mute = !value;
          await this.rcSetMute(mute);
          this.lastMuted = mute;
          // Sync speaker and mute switch
          try { this.speakerService.updateCharacteristic(Characteristic.Mute, mute); } catch {}
          try { this.muteService && this.muteService.updateCharacteristic(Characteristic.On, mute); } catch {}
        } catch (e) {
          this.log.error('Failed to set mute (Volume slider On):', e?.message || e);
          throw e;
        }
      });

    this.volumeService
      .addCharacteristic(Characteristic.Brightness)
      .onGet(() => this.lastVolume)
      .onSet(async (value) => {
        try {
          const vol = Math.max(0, Math.min(100, Number(value)));
          await this.rcSetVolume(vol);
          this.lastVolume = vol;
          if (vol > 0 && this.lastMuted) {
            // Unmute when setting a non-zero volume for better UX
            await this.rcSetMute(false);
            this.lastMuted = false;
            this.volumeService.updateCharacteristic(Characteristic.On, true);
            try { this.speakerService.updateCharacteristic(Characteristic.Mute, false); } catch {}
            try { this.muteService && this.muteService.updateCharacteristic(Characteristic.On, false); } catch {}
          }
        } catch (e) {
          this.log.error('Failed to set volume (Volume slider Brightness):', e?.message || e);
          throw e;
        }
      });

    // Separate Mute Toggle (Switch): On=true means Muted
    this.muteService = new Service.Switch(this.name + ' Mute');
    try { this.muteService.setCharacteristic(Characteristic.Name, 'Mute'); } catch {}
    this.muteService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.lastMuted)
      .onSet(async (value) => {
        try {
          const mute = !!value;
          await this.rcSetMute(mute);
          this.lastMuted = mute;
          // Sync other controls
          try { this.speakerService.updateCharacteristic(Characteristic.Mute, mute); } catch {}
          try { this.volumeService.updateCharacteristic(Characteristic.On, !mute); } catch {}
        } catch (e) {
          this.log.error('Failed to set mute (Mute switch):', e?.message || e);
          throw e;
        }
      });

    // Optional Inputs (requires URIs configured)
    this.inputSources = [];
    this.sources.forEach((src, index) => {
      const input = new Service.InputSource(src.name, 'input-' + index);
      input
        .setCharacteristic(Characteristic.Identifier, index)
        .setCharacteristic(Characteristic.ConfiguredName, src.name)
        .setCharacteristic(Characteristic.IsConfigured, Characteristic.IsConfigured.CONFIGURED)
        .setCharacteristic(Characteristic.InputSourceType, Characteristic.InputSourceType.OTHER)
        .setCharacteristic(Characteristic.CurrentVisibilityState, Characteristic.CurrentVisibilityState.SHOWN)
        .setCharacteristic(Characteristic.TargetVisibilityState, Characteristic.TargetVisibilityState.SHOWN);

      this.tvService.addLinkedService(input);
      // Expose input as its own service on the accessory rather than adding to tvService
      this.inputSources.push({ service: input, ...src });
    });

    if (this.inputSources.length > 0) {
      // Initialize to the first source until we can resolve the current one
      try {
        this.tvService.updateCharacteristic(Characteristic.ActiveIdentifier, 0);
      } catch {}

      this.tvService.getCharacteristic(Characteristic.ActiveIdentifier)
        .onGet(async () => {
          try {
            const media = await this.avtGetMediaInfo();
            const idx = this.inputSources.findIndex(s => s.uri && s.uri === media.currentURI);
            if (idx >= 0) {
              return this.inputSources[idx].service.getCharacteristic(Characteristic.Identifier).value;
            }
          } catch (e) {
            this.log.debug('ActiveIdentifier onGet fallback:', e?.message || e);
          }
          return 0;
        })
        .onSet(async (identifier) => {
          const src = this.inputSources.find(s => s.service.getCharacteristic(Characteristic.Identifier).value === identifier);
          if (!src) return;
          try {
            await this.avtSetUri(src.uri, { title: src.name, mime: src.mime });
          } catch (e) {
            this.log.error('Failed to switch source:', e?.message || e);
            throw e;
          }
        });
    }

    // Expose services
    this.services = [
      this.informationService,
      this.tvService,
      this.speakerService,
      this.hkSpeakerService,
      this.muteService,
      this.volumeService,
      ...this.inputSources.map(s => s.service)
    ];
  }

  getServices() {
    return this.services;
  }

  // ===== SOAP helpers =====
  async soapRequest(path, serviceType, action, innerXml) {
    if (!this.ip) throw new Error('ipAddress is not configured.');
    const url = `${this.baseUrl}${path}`;
    const envelope = `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
      `<s:Body>` +
      `<u:${action} xmlns:u="${serviceType}">` +
      innerXml +
      `</u:${action}>` +
      `</s:Body>` +
      `</s:Envelope>`;

    this.log.debug('SOAP', action, '->', url);
    const res = await axios.post(url, envelope, {
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        // Some renderers require SOAPAction to be quoted exactly like the UPnP spec examples
        'SOAPAction': `"${serviceType}#${action}"`,
        // Some buggy stacks only look for uppercase SOAPACTION
        'SOAPACTION': `"${serviceType}#${action}"`,
        'Connection': 'close',
      },
      timeout: this.timeouts,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}: ${typeof res.data === 'string' ? res.data : ''}`);
    }
  }

  parseUpnpErrorCode(err) {
    try {
      const t = String(err && err.message ? err.message : '');
      const m = t.match(/<errorCode>(\d+)<\/errorCode>/i);
      if (m) return parseInt(m[1], 10);
    } catch {}
    return null;
  }

  // ===== AVTransport query helpers =====
  async avtGetTransportInfo() {
    const inner = `\n<InstanceID>0</InstanceID>\n`;
    const path = '/AVTransport/ctrl';
    const st = 'urn:schemas-upnp-org:service:AVTransport:1';
    const action = 'GetTransportInfo';
    const res = await axios.post(`${this.baseUrl}${path}`,
      `<?xml version="1.0" encoding="utf-8"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${st}">${inner}</u:${action}></s:Body></s:Envelope>`,
      { headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'SOAPAction': `${st}#${action}`, 'Connection': 'close' }, timeout: this.timeouts, validateStatus: () => true });
    if (res.status < 200 || res.status >= 300 || typeof res.data !== 'string') return {};
    const body = res.data;
    const m = body.match(/<CurrentTransportState>([^<]*)<\/CurrentTransportState>/i);
    return { state: m ? m[1] : undefined };
  }

  async avtGetMediaInfo() {
    const inner = `\n<InstanceID>0</InstanceID>\n`;
    const path = '/AVTransport/ctrl';
    const st = 'urn:schemas-upnp-org:service:AVTransport:1';
    const action = 'GetMediaInfo';
    const res = await axios.post(`${this.baseUrl}${path}`,
      `<?xml version="1.0" encoding="utf-8"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${st}">${inner}</u:${action}></s:Body></s:Envelope>`,
      { headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'SOAPAction': `${st}#${action}`, 'Connection': 'close' }, timeout: this.timeouts, validateStatus: () => true });
    if (res.status < 200 || res.status >= 300 || typeof res.data !== 'string') return {};
    const body = res.data;
    const uri = (body.match(/<CurrentURI>([^<]*)<\/CurrentURI>/i) || [])[1] || '';
    const md  = (body.match(/<CurrentURIMetaData>([\s\S]*?)<\/CurrentURIMetaData>/i) || [])[1] || '';
    return { currentURI: uri, currentMeta: md };
  }

  // ===== RenderingControl (volume/mute) =====
  async rcSetVolume(volume) {
    const inner = `\n<InstanceID>0</InstanceID>\n<Channel>Master</Channel>\n<DesiredVolume>${volume}</DesiredVolume>\n`;
    await this.soapRequest('/RenderingControl/ctrl', 'urn:schemas-upnp-org:service:RenderingControl:1', 'SetVolume', inner);
  }

  async rcSetMute(mute) {
    const inner = `\n<InstanceID>0</InstanceID>\n<Channel>Master</Channel>\n<DesiredMute>${mute ? 1 : 0}</DesiredMute>\n`;
    await this.soapRequest('/RenderingControl/ctrl', 'urn:schemas-upnp-org:service:RenderingControl:1', 'SetMute', inner);
  }

  // ===== Helpers for metadata (UPnP 714 fix) =====
  mimeFromUri(uri, explicitMime) {
    if (explicitMime && typeof explicitMime === 'string') return explicitMime;
    try {
      const u = new URL(uri);
      const path = (u.pathname || '').toLowerCase();
      if (path.endsWith('.mp3')) return 'audio/mpeg';
      if (path.endsWith('.aac') || path.endsWith('.m4a')) return 'audio/aac';
      if (path.endsWith('.aacp')) return 'audio/aacp';
      if (path.endsWith('.flac')) return 'audio/flac';
      if (path.endsWith('.wav')) return 'audio/wav';
      if (path.endsWith('.ogg') || path.endsWith('.oga')) return 'audio/ogg';
      if (path.endsWith('.m3u') || path.endsWith('.m3u8')) return 'audio/mpegurl';
      if (path.endsWith('.pls')) return 'audio/x-scpls';
    } catch {}
    // Fallback most internet radio streams
    return 'audio/mpeg';
  }

  didlFor(uri, title, mime) {
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const t = esc(title || this.name || 'Stream');
    const protInfo = `http-get:*:${mime}:*`;
    return (
      `&lt;DIDL-Lite xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot; ` +
      `xmlns:dc=&quot;http://purl.org/dc/elements/1.1/&quot; ` +
      `xmlns:upnp=&quot;urn:schemas-upnp-org:metadata-1-0/upnp/&quot;&gt;` +
      `<item id=&quot;0&quot; parentID=&quot;-1&quot; restricted=&quot;1&quot;>` +
      `<dc:title>${t}</dc:title>` +
      `<upnp:class>object.item.audioItem</upnp:class>` +
      `<res protocolInfo=&quot;${protInfo}&quot;>${esc(uri)}</res>` +
      `</item>` +
      `</DIDL-Lite>`
    );
  }

  // ===== AVTransport (playback) =====
  // Note: AVTransport Play/Pause only controls the UPnP transport. Spotify Connect and some inputs may not honor Play unless already the active transport.
  async avtPlay() {
    const inner = `\n<InstanceID>0</InstanceID>\n<Speed>1</Speed>\n`;
    await this.soapRequest('/AVTransport/ctrl', 'urn:schemas-upnp-org:service:AVTransport:1', 'Play', inner);
  }

  async avtPause() {
    const inner = `\n<InstanceID>0</InstanceID>\n`;
    await this.soapRequest('/AVTransport/ctrl', 'urn:schemas-upnp-org:service:AVTransport:1', 'Pause', inner);
  }

  async avtStop() {
    const inner = `\n<InstanceID>0</InstanceID>\n`;
    await this.soapRequest('/AVTransport/ctrl', 'urn:schemas-upnp-org:service:AVTransport:1', 'Stop', inner);
  }

  async avtNext() {
    const inner = `\n<InstanceID>0</InstanceID>\n`;
    await this.soapRequest('/AVTransport/ctrl', 'urn:schemas-upnp-org:service:AVTransport:1', 'Next', inner);
  }

  async avtPrevious() {
    const inner = `\n<InstanceID>0</InstanceID>\n`;
    await this.soapRequest('/AVTransport/ctrl', 'urn:schemas-upnp-org:service:AVTransport:1', 'Previous', inner);
  }

  async avtPlayPause() {
    try {
      const media = await this.avtGetMediaInfo();
      if (!media.currentURI) {
        this.log.debug('avtPlayPause: no UPnP CurrentURI; ignoring.');
        return;
      }
      const tinfo = await this.avtGetTransportInfo();
      const s = (tinfo.state || '').toUpperCase();
      if (s === 'PLAYING' || s === 'TRANSITIONING') {
        await this.avtPause();
      } else {
        await this.avtPlay();
      }
    } catch (e) {
      this.log.debug('avtPlayPause failed:', e?.message || e);
    }
  }

  async avtSetUri(uri, opts = {}) {
    // Switch source by setting transport URI; include DIDL-Lite metadata to satisfy strict renderers
    const title = opts.title || opts.name || 'Stream';
    const mime = this.mimeFromUri(uri, opts.mime);
    const metadata = this.didlFor(uri, title, mime);
    const inner = `\n<InstanceID>0</InstanceID>\n<CurrentURI>${uri}</CurrentURI>\n<CurrentURIMetaData>${metadata}</CurrentURIMetaData>\n`;
    this.log.debug('SetAVTransportURI', { uri, mime, title });
    await this.soapRequest('/AVTransport/ctrl', 'urn:schemas-upnp-org:service:AVTransport:1', 'SetAVTransportURI', inner);
  }

  async avtSetDefaultUriIfConfigured() {
    // Use defaultUri if set; otherwise first configured source
    let src = null;
    if (this.defaultUri) src = { uri: this.defaultUri, name: 'Default', mime: null };
    else if (this.sources.length > 0) src = this.sources[0];
    if (!src || !src.uri) {
      this.log.debug('No defaultUri or sources configured; skipping SetAVTransportURI.');
      return;
    }
    this.log.debug('Setting default transport URI:', src.uri);
    try {
      await this.avtSetUri(src.uri, { title: src.name, mime: src.mime });
    } catch (e) {
      this.log.warn('Failed to set default URI:', e?.message || e);
    }
  }
}
