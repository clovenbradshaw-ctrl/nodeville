/* ==========================================================================
   Hyphae Mesh - QR Code Generator
   Generates Meshtastic channel configuration URLs and QR codes
   ========================================================================== */

(function() {
  'use strict';

  /* ==========================================================================
     Meshtastic Configuration
     ========================================================================== */

  // Hyphae Mesh Nashville network defaults
  const HYPHAE_MESH_CONFIG = {
    lora: {
      region: 1,           // US (RegionCode.US)
      modemPreset: 3,      // MEDIUM_FAST (ModemPreset.MEDIUM_FAST)
      hopLimit: 6,
      txEnabled: true,
      txPower: 30
    },
    channel: {
      name: '',            // Blank for primary per TN convention
      psk: new Uint8Array([1]), // Default public key (AQ==)
      uplinkEnabled: true,
      downlinkEnabled: true
    }
  };

  /* ==========================================================================
     Protobuf-lite Encoding
     Simplified encoding for Meshtastic ChannelSet proto message
     ========================================================================== */

  // Protobuf wire types
  const WIRE_TYPE = {
    VARINT: 0,
    FIXED64: 1,
    LENGTH_DELIMITED: 2,
    FIXED32: 5
  };

  function encodeVarint(value) {
    const bytes = [];
    while (value > 0x7f) {
      bytes.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    bytes.push(value & 0x7f);
    return new Uint8Array(bytes);
  }

  function encodeField(fieldNumber, wireType, data) {
    const tag = (fieldNumber << 3) | wireType;
    const tagBytes = encodeVarint(tag);

    if (wireType === WIRE_TYPE.VARINT) {
      return new Uint8Array([...tagBytes, ...encodeVarint(data)]);
    } else if (wireType === WIRE_TYPE.LENGTH_DELIMITED) {
      const length = encodeVarint(data.length);
      return new Uint8Array([...tagBytes, ...length, ...data]);
    }
    return tagBytes;
  }

  function encodeString(fieldNumber, str) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    return encodeField(fieldNumber, WIRE_TYPE.LENGTH_DELIMITED, bytes);
  }

  function encodeBytes(fieldNumber, bytes) {
    return encodeField(fieldNumber, WIRE_TYPE.LENGTH_DELIMITED, bytes);
  }

  function encodeUint32(fieldNumber, value) {
    return encodeField(fieldNumber, WIRE_TYPE.VARINT, value);
  }

  function encodeBool(fieldNumber, value) {
    return encodeField(fieldNumber, WIRE_TYPE.VARINT, value ? 1 : 0);
  }

  /* ==========================================================================
     Meshtastic Proto Message Builders
     ========================================================================== */

  // Build ChannelSettings proto
  function buildChannelSettings(settings) {
    const parts = [];

    // field 1: channel_num (int32) - only for non-primary channels
    if (settings.channelNum !== undefined && settings.channelNum > 0) {
      parts.push(encodeUint32(1, settings.channelNum));
    }

    // field 2: psk (bytes)
    if (settings.psk) {
      parts.push(encodeBytes(2, settings.psk));
    }

    // field 3: name (string)
    if (settings.name) {
      parts.push(encodeString(3, settings.name));
    }

    // field 4: id (fixed32) - computed from name hash
    // field 5: uplink_enabled (bool)
    if (settings.uplinkEnabled !== undefined) {
      parts.push(encodeBool(5, settings.uplinkEnabled));
    }

    // field 6: downlink_enabled (bool)
    if (settings.downlinkEnabled !== undefined) {
      parts.push(encodeBool(6, settings.downlinkEnabled));
    }

    return concatUint8Arrays(parts);
  }

  // Build Channel proto
  function buildChannel(channel) {
    const parts = [];

    // field 1: index (int32)
    if (channel.index !== undefined) {
      parts.push(encodeUint32(1, channel.index));
    }

    // field 2: settings (ChannelSettings)
    if (channel.settings) {
      const settings = buildChannelSettings(channel.settings);
      parts.push(encodeField(2, WIRE_TYPE.LENGTH_DELIMITED, settings));
    }

    // field 3: role (ChannelRole enum)
    if (channel.role !== undefined) {
      parts.push(encodeUint32(3, channel.role));
    }

    return concatUint8Arrays(parts);
  }

  // Build LoRaConfig proto
  function buildLoRaConfig(lora) {
    const parts = [];

    // field 3: region (RegionCode enum)
    if (lora.region !== undefined) {
      parts.push(encodeUint32(3, lora.region));
    }

    // field 4: modem_preset (ModemPreset enum)
    if (lora.modemPreset !== undefined) {
      parts.push(encodeUint32(4, lora.modemPreset));
    }

    // field 7: hop_limit (uint32)
    if (lora.hopLimit !== undefined) {
      parts.push(encodeUint32(7, lora.hopLimit));
    }

    // field 11: tx_enabled (bool)
    if (lora.txEnabled !== undefined) {
      parts.push(encodeBool(11, lora.txEnabled));
    }

    // field 12: tx_power (int32)
    if (lora.txPower !== undefined) {
      parts.push(encodeUint32(12, lora.txPower));
    }

    return concatUint8Arrays(parts);
  }

  // Build ChannelSet proto (main message)
  function buildChannelSet(config) {
    const parts = [];

    // field 1: settings (repeated Channel)
    if (config.channels) {
      config.channels.forEach(channel => {
        const channelBytes = buildChannel(channel);
        parts.push(encodeField(1, WIRE_TYPE.LENGTH_DELIMITED, channelBytes));
      });
    }

    // field 2: lora_config (LoRaConfig)
    if (config.lora) {
      const loraBytes = buildLoRaConfig(config.lora);
      parts.push(encodeField(2, WIRE_TYPE.LENGTH_DELIMITED, loraBytes));
    }

    return concatUint8Arrays(parts);
  }

  /* ==========================================================================
     URL Generation
     ========================================================================== */

  function generateMeshtasticURL(config) {
    const protoBytes = buildChannelSet(config);
    const base64 = uint8ArrayToBase64URL(protoBytes);
    return `https://meshtastic.org/e/#${base64}`;
  }

  // Generate the standard Hyphae Mesh Nashville config URL
  function generateHyphaeNetworkURL() {
    const config = {
      lora: HYPHAE_MESH_CONFIG.lora,
      channels: [{
        index: 0,
        settings: {
          name: HYPHAE_MESH_CONFIG.channel.name,
          psk: HYPHAE_MESH_CONFIG.channel.psk,
          uplinkEnabled: HYPHAE_MESH_CONFIG.channel.uplinkEnabled,
          downlinkEnabled: HYPHAE_MESH_CONFIG.channel.downlinkEnabled
        },
        role: 1  // PRIMARY
      }]
    };

    return generateMeshtasticURL(config);
  }

  // Generate a private channel URL with random PSK
  function generatePrivateChannelURL(channelName) {
    const psk = generateRandomPSK();

    const config = {
      lora: HYPHAE_MESH_CONFIG.lora,
      channels: [{
        index: 0,
        settings: {
          name: channelName || 'Private',
          psk: psk,
          uplinkEnabled: false,  // Private channels don't uplink
          downlinkEnabled: false
        },
        role: 1  // PRIMARY
      }]
    };

    return {
      url: generateMeshtasticURL(config),
      psk: uint8ArrayToBase64(psk)
    };
  }

  /* ==========================================================================
     Crypto Utilities
     ========================================================================== */

  function generateRandomPSK() {
    // 256-bit AES key
    return crypto.getRandomValues(new Uint8Array(32));
  }

  /* ==========================================================================
     Encoding Utilities
     ========================================================================== */

  function concatUint8Arrays(arrays) {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }

  function uint8ArrayToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function uint8ArrayToBase64URL(bytes) {
    return uint8ArrayToBase64(bytes)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }

  /* ==========================================================================
     QR Code Generation (requires qrcode.js library)
     ========================================================================== */

  async function generateQRCode(text, canvas, size = 256) {
    if (typeof QRCode === 'undefined') {
      console.error('QRCode library not loaded');
      return false;
    }

    try {
      await QRCode.toCanvas(canvas, text, {
        width: size,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff'
        },
        errorCorrectionLevel: 'M'
      });
      return true;
    } catch (err) {
      console.error('QR generation error:', err);
      return false;
    }
  }

  async function generateQRDataURL(text, size = 256) {
    if (typeof QRCode === 'undefined') {
      console.error('QRCode library not loaded');
      return null;
    }

    try {
      return await QRCode.toDataURL(text, {
        width: size,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#ffffff'
        },
        errorCorrectionLevel: 'M'
      });
    } catch (err) {
      console.error('QR generation error:', err);
      return null;
    }
  }

  /* ==========================================================================
     Public API
     ========================================================================== */

  window.HyphaeMesh = {
    // Configuration
    config: HYPHAE_MESH_CONFIG,

    // URL generation
    generateNetworkURL: generateHyphaeNetworkURL,
    generatePrivateChannelURL: generatePrivateChannelURL,
    generateMeshtasticURL: generateMeshtasticURL,

    // QR code generation
    generateQRCode: generateQRCode,
    generateQRDataURL: generateQRDataURL,

    // Crypto
    generateRandomPSK: generateRandomPSK,

    // Utilities
    uint8ArrayToBase64: uint8ArrayToBase64,
    uint8ArrayToBase64URL: uint8ArrayToBase64URL
  };

  /* ==========================================================================
     Auto-initialize QR codes on page load
     ========================================================================== */

  document.addEventListener('DOMContentLoaded', async function() {
    // Auto-generate network QR codes
    const networkQRs = document.querySelectorAll('[data-qr="network"]');
    const networkURL = generateHyphaeNetworkURL();

    for (const element of networkQRs) {
      if (element.tagName === 'CANVAS') {
        await generateQRCode(networkURL, element, parseInt(element.dataset.size) || 256);
      }
    }

    // Update any URL display elements
    const urlDisplays = document.querySelectorAll('[data-network-url]');
    urlDisplays.forEach(el => {
      el.textContent = networkURL;
    });

    // Handle private channel generator form
    const privateForm = document.getElementById('private-channel-form');
    if (privateForm) {
      privateForm.addEventListener('submit', async function(e) {
        e.preventDefault();

        const nameInput = document.getElementById('channel-name');
        const qrCanvas = document.getElementById('private-qr');
        const urlDisplay = document.getElementById('private-url');
        const resultSection = document.getElementById('private-result');

        if (!nameInput || !qrCanvas) return;

        const channelName = nameInput.value.trim() || 'Private';
        const result = generatePrivateChannelURL(channelName);

        await generateQRCode(result.url, qrCanvas, 256);

        if (urlDisplay) {
          urlDisplay.textContent = result.url;
        }

        if (resultSection) {
          resultSection.style.display = 'block';
          resultSection.scrollIntoView({ behavior: 'smooth' });
        }
      });
    }
  });

})();
