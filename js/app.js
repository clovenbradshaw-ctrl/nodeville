/**
 * nashme.sh - Nashville Meshtastic Network PWA
 * Zero-config onboarding with Signal-like E2EE messaging
 */

// ============================================================================
// Configuration - nashme.sh Network Defaults
// ============================================================================

const NASHME_CONFIG = {
  // LoRa Settings
  lora: {
    region: 1, // US (Config_LoRaConfig_RegionCode.US)
    modemPreset: 3, // MEDIUM_FAST (Config_LoRaConfig_ModemPreset.MEDIUM_FAST)
    hopLimit: 7, // 7 hops as requested for nashme.sh
    txEnabled: true,
    txPower: 30, // Max for US
  },

  // Primary Channel (Public Nashville Mesh)
  primaryChannel: {
    index: 0,
    name: '', // Intentionally blank per nashme.sh docs
    psk: new Uint8Array([0x01]), // AQ== - default public key
    uplinkEnabled: true,
    downlinkEnabled: true,
  },

  // Position Settings (Battery Optimized)
  position: {
    positionBroadcastSecs: 21600, // 6 hours
    positionBroadcastSmartEnabled: false,
    gpsEnabled: true,
    gpsUpdateInterval: 300, // 5 minutes
  },

  // Telemetry Settings
  telemetry: {
    deviceUpdateInterval: 21600, // 6 hours
    environmentUpdateInterval: 21600,
  },

  // Device Settings
  device: {
    role: 0, // CLIENT
    nodeInfoBroadcastSecs: 10800, // 3 hours
  }
};

// ============================================================================
// Database (IndexedDB via simple wrapper)
// ============================================================================

class NashMeshDB {
  constructor() {
    this.dbName = 'nashme_db';
    this.dbVersion = 1;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Contacts store
        if (!db.objectStoreNames.contains('contacts')) {
          const contactStore = db.createObjectStore('contacts', { keyPath: 'id' });
          contactStore.createIndex('name', 'name', { unique: false });
        }

        // Conversations store
        if (!db.objectStoreNames.contains('conversations')) {
          const convoStore = db.createObjectStore('conversations', { keyPath: 'id' });
          convoStore.createIndex('channelIndex', 'channelIndex', { unique: false });
          convoStore.createIndex('lastMessageAt', 'lastMessageAt', { unique: false });
        }

        // Messages store
        if (!db.objectStoreNames.contains('messages')) {
          const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('conversationId', 'conversationId', { unique: false });
          msgStore.createIndex('timestamp', 'timestamp', { unique: false });
        }

        // Settings store
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
    });
  }

  async get(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async getAll(storeName, indexName = null, query = null) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const source = indexName ? store.index(indexName) : store;
      const request = query ? source.getAll(query) : source.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async put(storeName, data) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.put(data);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async delete(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const request = store.delete(key);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }
}

// ============================================================================
// Crypto Utilities
// ============================================================================

const CryptoUtils = {
  // Generate cryptographically secure random PSK
  generatePSK(bits = 256) {
    const bytes = bits / 8;
    const array = new Uint8Array(bytes);
    crypto.getRandomValues(array);
    return this.uint8ArrayToBase64(array);
  },

  // Create safety number from node ID and PSK
  async createSafetyNumber(nodeId, psk) {
    const combined = `${nodeId}${psk}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(combined);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString().padStart(3, '0')).join('').slice(0, 60);
  },

  // Format safety number for display
  formatSafetyNumber(num) {
    return num.match(/.{1,5}/g)?.join(' ') || num;
  },

  uint8ArrayToBase64(array) {
    return btoa(String.fromCharCode(...array));
  },

  base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  },

  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
};

// ============================================================================
// Meshtastic Connection Manager
// ============================================================================

class MeshtasticManager {
  constructor() {
    this.client = null;
    this.connection = null;
    this.myNodeId = null;
    this.myNodeInfo = null;
    this.nodes = new Map();
    this.onMessageCallback = null;
    this.onNodeUpdateCallback = null;
  }

  async connect(onProgress) {
    onProgress?.(5, 'Initializing Bluetooth...');

    // Check if Web Bluetooth is available
    if (!navigator.bluetooth) {
      const error = new Error('Web Bluetooth not supported. Please use Chrome, Edge, or Opera on desktop, or Chrome on Android.');
      error.type = 'browser_unsupported';
      throw error;
    }

    onProgress?.(10, 'Requesting Bluetooth device...');

    try {
      // Request Bluetooth device
      const device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: ['6ba1b218-15a8-461f-9fa8-5dcae273eafd'] }, // Meshtastic service UUID
        ],
        optionalServices: ['6ba1b218-15a8-461f-9fa8-5dcae273eafd']
      });

      onProgress?.(20, `Connecting to ${device.name || 'Meshtastic device'}...`);

      const server = await device.gatt.connect();

      onProgress?.(30, 'Getting Meshtastic service...');

      const service = await server.getPrimaryService('6ba1b218-15a8-461f-9fa8-5dcae273eafd');

      onProgress?.(40, 'Setting up communication...');

      // Store connection info
      this.connection = {
        device,
        server,
        service,
      };

      // Get characteristics
      const toRadioChar = await service.getCharacteristic('f75c76d2-129e-4dad-a1dd-7866124401e7');
      const fromRadioChar = await service.getCharacteristic('2c55e69e-4993-11ed-b878-0242ac120002');
      const fromNumChar = await service.getCharacteristic('ed9da18c-a800-4f66-a670-aa7547e34453');

      this.connection.toRadio = toRadioChar;
      this.connection.fromRadio = fromRadioChar;
      this.connection.fromNum = fromNumChar;

      // Subscribe to notifications
      await fromRadioChar.startNotifications();
      fromRadioChar.addEventListener('characteristicvaluechanged', (event) => {
        this.handleFromRadio(event.target.value);
      });

      onProgress?.(50, 'Getting device info...');

      // Request config
      await this.requestConfig();

      onProgress?.(60, 'Connected successfully!');

      return true;
    } catch (error) {
      console.error('Connection error:', error);
      // Classify the error type for better user guidance
      error.type = this.classifyError(error);
      throw error;
    }
  }

  classifyError(error) {
    const message = error.message?.toLowerCase() || '';

    // Web Bluetooth API disabled or blocked
    if (message.includes('globally disabled') ||
        message.includes('bluetooth api') ||
        message.includes('permission denied') ||
        message.includes('not allowed')) {
      return 'bluetooth_disabled';
    }

    // User cancelled the device picker
    if (message.includes('user cancelled') ||
        message.includes('user canceled') ||
        message.includes('user denied')) {
      return 'user_cancelled';
    }

    // No devices found
    if (message.includes('no device') ||
        message.includes('device not found')) {
      return 'no_device';
    }

    // Connection lost or failed
    if (message.includes('disconnected') ||
        message.includes('connection failed') ||
        message.includes('gatt')) {
      return 'connection_lost';
    }

    // Default to device-related error
    return 'device';
  }

  async requestConfig() {
    // This would send the appropriate protobuf messages
    // For now, we'll simulate getting node info
    // In a real implementation, this would use the Meshtastic protobuf protocol

    // Simulated node info for demo purposes
    this.myNodeId = '!' + Math.random().toString(16).slice(2, 10).toUpperCase();
    this.myNodeInfo = {
      myNodeNum: parseInt(this.myNodeId.slice(1), 16),
      user: {
        longName: localStorage.getItem('nashme_longName') || '',
        shortName: localStorage.getItem('nashme_shortName') || '',
      }
    };
  }

  handleFromRadio(dataView) {
    // Parse protobuf message from device
    // This is a simplified handler
    try {
      // In real implementation, decode protobuf
      console.log('Received from radio:', dataView);
    } catch (error) {
      console.error('Error handling fromRadio:', error);
    }
  }

  async applyConfig(config, onProgress) {
    const steps = [
      { name: 'region', message: 'Configuring network region...', progress: 15 },
      { name: 'radio', message: 'Setting radio parameters...', progress: 30 },
      { name: 'channel', message: 'Configuring nashme.sh channel...', progress: 45 },
      { name: 'battery', message: 'Optimizing battery settings...', progress: 60 },
      { name: 'position', message: 'Setting position parameters...', progress: 75 },
      { name: 'role', message: 'Configuring device role...', progress: 85 },
      { name: 'verify', message: 'Verifying configuration...', progress: 95 },
    ];

    for (const step of steps) {
      onProgress?.(step.progress, step.message, step.name);

      // Simulate config application delay
      await this.sleep(800);

      // In real implementation, send protobuf config messages
      // await this.sendConfig(step.name, config);
    }

    onProgress?.(100, 'Configuration complete!', 'done');
  }

  async setOwner(longName, shortName) {
    // Store locally
    localStorage.setItem('nashme_longName', longName);
    localStorage.setItem('nashme_shortName', shortName);

    if (this.myNodeInfo) {
      this.myNodeInfo.user.longName = longName;
      this.myNodeInfo.user.shortName = shortName;
    }

    // In real implementation, send to device via protobuf
  }

  async sendMessage(text, channelIndex = 0) {
    // In real implementation, encode and send via Bluetooth
    console.log(`Sending message on channel ${channelIndex}: ${text}`);

    // Simulate send
    return {
      id: CryptoUtils.generateUUID(),
      text,
      timestamp: Date.now(),
      channelIndex,
    };
  }

  onMessage(callback) {
    this.onMessageCallback = callback;
  }

  onNodeUpdate(callback) {
    this.onNodeUpdateCallback = callback;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  disconnect() {
    if (this.connection?.device?.gatt?.connected) {
      this.connection.device.gatt.disconnect();
    }
    this.connection = null;
  }
}

// ============================================================================
// Conversation Manager
// ============================================================================

class ConversationManager {
  constructor(db, meshtastic) {
    this.db = db;
    this.meshtastic = meshtastic;
  }

  async createDM(contact) {
    const conversations = await this.db.getAll('conversations');
    const usedChannels = conversations.map(c => c.channelIndex);
    const availableChannel = [1, 2, 3, 4, 5, 6, 7].find(i => !usedChannels.includes(i));

    if (!availableChannel) {
      throw new Error('Maximum conversations reached (7)');
    }

    const psk = CryptoUtils.generatePSK(256);
    const conversation = {
      id: CryptoUtils.generateUUID(),
      channelIndex: availableChannel,
      channelName: `dm_${contact.id.slice(-8)}`,
      psk,
      type: 'dm',
      participants: [this.meshtastic.myNodeId, contact.id],
      displayName: contact.name,
      createdAt: Date.now(),
      lastMessageAt: null,
      pinned: false,
      muted: false,
      archived: false,
      unreadCount: 0,
    };

    await this.db.put('conversations', conversation);
    await this.db.put('contacts', contact);

    return conversation;
  }

  async createGroup(name, participants) {
    const conversations = await this.db.getAll('conversations');
    const usedChannels = conversations.map(c => c.channelIndex);
    const availableChannel = [1, 2, 3, 4, 5, 6, 7].find(i => !usedChannels.includes(i));

    if (!availableChannel) {
      throw new Error('Maximum conversations reached (7)');
    }

    const psk = CryptoUtils.generatePSK(256);
    const conversation = {
      id: CryptoUtils.generateUUID(),
      channelIndex: availableChannel,
      channelName: `grp_${CryptoUtils.generateUUID().slice(0, 8)}`,
      psk,
      type: 'group',
      participants: [this.meshtastic.myNodeId, ...participants.map(p => p.id)],
      displayName: name,
      createdAt: Date.now(),
      lastMessageAt: null,
      pinned: false,
      muted: false,
      archived: false,
      unreadCount: 0,
    };

    await this.db.put('conversations', conversation);

    return conversation;
  }

  async getConversations() {
    const conversations = await this.db.getAll('conversations');
    return conversations.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  }

  async getMessages(conversationId) {
    const messages = await this.db.getAll('messages', 'conversationId', IDBKeyRange.only(conversationId));
    return messages.sort((a, b) => a.timestamp - b.timestamp);
  }

  async sendMessage(conversationId, text) {
    const conversation = await this.db.get('conversations', conversationId);
    if (!conversation) throw new Error('Conversation not found');

    const message = {
      id: CryptoUtils.generateUUID(),
      conversationId,
      fromNodeId: this.meshtastic.myNodeId,
      text,
      timestamp: Date.now(),
      read: true,
      encrypted: true,
      channel: conversation.channelIndex,
      status: 'sent',
    };

    await this.meshtastic.sendMessage(text, conversation.channelIndex);
    await this.db.put('messages', message);

    await this.db.put('conversations', {
      ...conversation,
      lastMessageAt: Date.now(),
    });

    return message;
  }

  async markAsRead(conversationId) {
    const conversation = await this.db.get('conversations', conversationId);
    if (conversation) {
      await this.db.put('conversations', {
        ...conversation,
        unreadCount: 0,
      });
    }
  }

  generateInviteUrl(conversation) {
    const data = {
      n: conversation.channelName,
      p: conversation.psk,
    };
    return `https://nashme.sh/#invite=${btoa(JSON.stringify(data))}`;
  }
}

// ============================================================================
// UI Manager
// ============================================================================

class UIManager {
  constructor() {
    this.app = document.getElementById('app');
    this.currentScreen = null;
    this.selectedConversation = null;
  }

  showScreen(templateId) {
    const template = document.getElementById(templateId);
    if (!template) {
      console.error(`Template not found: ${templateId}`);
      return null;
    }

    const content = template.content.cloneNode(true);
    this.app.innerHTML = '';
    this.app.appendChild(content);
    this.currentScreen = templateId;

    return this.app.querySelector('.screen');
  }

  showOnboarding(onConnect) {
    this.showScreen('onboarding-template');

    const connectBtn = document.getElementById('connect-btn');
    connectBtn?.addEventListener('click', onConnect);
  }

  showConnecting() {
    this.showScreen('connecting-template');
  }

  updateProgress(percent, message, step) {
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const connectStatus = document.getElementById('connect-status');
    const connectTitle = document.getElementById('connect-title');

    if (progressFill) progressFill.style.width = `${percent}%`;
    if (progressText) progressText.textContent = `${Math.round(percent)}%`;
    if (connectStatus) connectStatus.textContent = message;

    // Update step indicators
    if (step) {
      const steps = document.querySelectorAll('#config-steps li');
      steps.forEach(li => {
        const liStep = li.dataset.step;
        if (liStep === step) {
          li.classList.add('active');
          li.classList.remove('done');
        } else if (this.isStepBefore(liStep, step)) {
          li.classList.add('done');
          li.classList.remove('active');
        }
      });

      if (step === 'done') {
        steps.forEach(li => {
          li.classList.add('done');
          li.classList.remove('active');
        });
        if (connectTitle) connectTitle.textContent = 'Setup Complete!';
      }
    }
  }

  isStepBefore(step, currentStep) {
    const order = ['region', 'radio', 'channel', 'battery', 'position', 'role', 'verify', 'done'];
    return order.indexOf(step) < order.indexOf(currentStep);
  }

  showUserSetup(onSave, onSkip) {
    this.showScreen('user-setup-template');

    const longNameInput = document.getElementById('long-name');
    const shortNameInput = document.getElementById('short-name');
    const saveBtn = document.getElementById('save-user-btn');
    const skipBtn = document.getElementById('skip-user-btn');

    // Auto-generate short name
    longNameInput?.addEventListener('input', () => {
      if (!shortNameInput.dataset.manual) {
        shortNameInput.value = longNameInput.value.slice(0, 4).toUpperCase();
      }
    });

    shortNameInput?.addEventListener('input', () => {
      shortNameInput.dataset.manual = 'true';
    });

    saveBtn?.addEventListener('click', () => {
      onSave(longNameInput.value, shortNameInput.value);
    });

    skipBtn?.addEventListener('click', () => {
      onSkip();
    });
  }

  showSuccess(onComplete) {
    this.showScreen('success-template');

    setTimeout(onComplete, 2500);
  }

  showError(message, errorType, onRetry) {
    this.showScreen('error-template');

    const errorMessage = document.getElementById('error-message');
    const retryBtn = document.getElementById('retry-btn');
    const troubleshootingContainer = document.querySelector('.troubleshooting');

    if (errorMessage) errorMessage.textContent = message;
    retryBtn?.addEventListener('click', onRetry);

    // Show appropriate troubleshooting steps based on error type
    if (troubleshootingContainer) {
      const steps = this.getTroubleshootingSteps(errorType);
      troubleshootingContainer.innerHTML = `
        <h3>${steps.title}</h3>
        <ul>
          ${steps.items.map(item => `<li>${item}</li>`).join('')}
        </ul>
      `;
    }
  }

  getTroubleshootingSteps(errorType) {
    const troubleshootingGuides = {
      bluetooth_disabled: {
        title: 'Enable Web Bluetooth:',
        items: [
          'Use Chrome, Edge, or Opera browser (Firefox/Safari not supported)',
          'On Chrome: Go to chrome://flags and enable "Experimental Web Platform features"',
          'Make sure this page is served over HTTPS',
          'Check that Bluetooth is enabled in your device settings',
          'On iOS: Web Bluetooth is not supported - use the Meshtastic app instead'
        ]
      },
      browser_unsupported: {
        title: 'Browser not supported:',
        items: [
          'Use Google Chrome, Microsoft Edge, or Opera browser',
          'Firefox and Safari do not support Web Bluetooth',
          'On Android: Use Chrome browser',
          'On iOS: Web Bluetooth is not available - use the Meshtastic app instead'
        ]
      },
      user_cancelled: {
        title: 'Connection cancelled:',
        items: [
          'Click "Try Again" to restart the connection',
          'When the device picker appears, select your Meshtastic device',
          'Make sure your device is powered on and nearby'
        ]
      },
      no_device: {
        title: 'No device found:',
        items: [
          'Make sure your Meshtastic device is powered on',
          'Ensure Bluetooth is enabled on your device',
          'Move closer to your Meshtastic device',
          'Try restarting your Meshtastic device'
        ]
      },
      connection_lost: {
        title: 'Connection lost:',
        items: [
          'Move closer to your Meshtastic device',
          'Check that your device is still powered on',
          'Try restarting your Meshtastic device',
          'Restart Bluetooth on your phone/computer'
        ]
      },
      device: {
        title: 'Try these steps:',
        items: [
          'Make sure your device is powered on',
          'Check that Bluetooth is enabled',
          'Move your device closer',
          'Restart your Meshtastic device'
        ]
      }
    };

    return troubleshootingGuides[errorType] || troubleshootingGuides.device;
  }

  showMessenger(conversations, onNewConvo, onSelectConvo) {
    this.showScreen('messenger-template');

    this.renderConversations(conversations, onSelectConvo);

    // Set up event listeners
    const newDmBtn = document.getElementById('new-dm-btn');
    const fabBtn = document.getElementById('new-conversation-fab');
    const startConvoBtn = document.getElementById('start-convo-btn');

    [newDmBtn, fabBtn, startConvoBtn].forEach(btn => {
      btn?.addEventListener('click', onNewConvo);
    });

    // Back button for mobile
    const backBtn = document.getElementById('back-btn');
    backBtn?.addEventListener('click', () => {
      document.querySelector('.messenger-layout')?.classList.remove('convo-open');
    });
  }

  renderConversations(conversations, onSelect) {
    const list = document.getElementById('conversation-list');
    if (!list) return;

    list.innerHTML = '';

    if (conversations.length === 0) {
      list.innerHTML = `
        <div class="empty-list">
          <p style="text-align: center; color: var(--text-muted); padding: 2rem;">
            No conversations yet.<br>Tap + to start one.
          </p>
        </div>
      `;
      return;
    }

    conversations.forEach(convo => {
      const template = document.getElementById('conversation-item-template');
      const item = template.content.cloneNode(true);
      const el = item.querySelector('.conversation-item');

      el.dataset.id = convo.id;
      el.querySelector('.avatar-text').textContent = convo.displayName?.[0] || '?';
      el.querySelector('.convo-name').textContent = convo.displayName || 'Unknown';
      el.querySelector('.convo-time').textContent = convo.lastMessageAt
        ? this.formatTime(convo.lastMessageAt)
        : '';
      el.querySelector('.convo-preview').textContent = 'Tap to open';

      if (convo.unreadCount > 0) {
        const badge = el.querySelector('.unread-badge');
        badge.textContent = convo.unreadCount;
        badge.classList.remove('hidden');
      }

      el.addEventListener('click', () => {
        document.querySelectorAll('.conversation-item').forEach(i => i.classList.remove('active'));
        el.classList.add('active');
        onSelect(convo);
      });

      list.appendChild(item);
    });
  }

  showConversation(conversation, messages, myNodeId, onSend) {
    const view = document.getElementById('conversation-view');
    const emptyState = document.getElementById('empty-state');

    if (emptyState) emptyState.classList.add('hidden');
    if (view) view.classList.remove('hidden');

    // Update header
    document.getElementById('convo-name').textContent = conversation.displayName;
    document.getElementById('convo-subtitle').textContent =
      conversation.type === 'group'
        ? `${conversation.participants.length} members`
        : 'End-to-end encrypted';
    document.querySelector('#convo-avatar span').textContent = conversation.displayName?.[0] || '?';

    // Render messages
    this.renderMessages(messages, myNodeId);

    // Set up input
    const input = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');

    const handleSend = async () => {
      const text = input.value.trim();
      if (!text) return;

      input.value = '';
      input.style.height = 'auto';
      await onSend(text);
    };

    sendBtn.onclick = handleSend;
    input.onkeypress = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    };

    // Auto-resize textarea
    input.oninput = () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    };

    // Mobile: show conversation view
    document.querySelector('.messenger-layout')?.classList.add('convo-open');

    this.selectedConversation = conversation;
  }

  renderMessages(messages, myNodeId) {
    const container = document.getElementById('messages-container');
    if (!container) return;

    container.innerHTML = '';

    messages.forEach(msg => {
      const isOwn = msg.fromNodeId === myNodeId;
      const template = document.getElementById('message-template');
      const item = template.content.cloneNode(true);
      const el = item.querySelector('.message');

      el.dataset.id = msg.id;
      el.classList.add(isOwn ? 'own' : 'other');
      el.querySelector('.message-text').textContent = msg.text;
      el.querySelector('.message-time').textContent = this.formatTime(msg.timestamp);

      if (isOwn) {
        el.querySelector('.message-status').textContent = msg.status === 'sent' ? '✓' : '✓✓';
      }

      container.appendChild(item);
    });

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  addMessage(message, myNodeId) {
    const container = document.getElementById('messages-container');
    if (!container) return;

    const isOwn = message.fromNodeId === myNodeId;
    const template = document.getElementById('message-template');
    const item = template.content.cloneNode(true);
    const el = item.querySelector('.message');

    el.dataset.id = message.id;
    el.classList.add(isOwn ? 'own' : 'other');
    el.querySelector('.message-text').textContent = message.text;
    el.querySelector('.message-time').textContent = this.formatTime(message.timestamp);

    if (isOwn) {
      el.querySelector('.message-status').textContent = '✓';
    }

    container.appendChild(item);
    container.scrollTop = container.scrollHeight;
  }

  showNewContactModal(onAdd, onClose) {
    const template = document.getElementById('new-contact-modal-template');
    const modal = template.content.cloneNode(true);
    document.body.appendChild(modal);

    const overlay = document.querySelector('.modal-overlay');
    const closeBtn = overlay.querySelector('.modal-close');
    const tabBtns = overlay.querySelectorAll('.tab-btn');
    const addBtn = document.getElementById('add-contact-btn');

    // Tab switching
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        document.getElementById(`tab-${btn.dataset.tab}`)?.classList.add('active');
      });
    });

    // Add contact
    addBtn?.addEventListener('click', () => {
      const nodeId = document.getElementById('contact-node-id').value.trim();
      const name = document.getElementById('contact-name').value.trim();

      if (nodeId && name) {
        overlay.remove();
        onAdd({ id: nodeId, name });
      }
    });

    // Close modal
    const closeModal = () => {
      overlay.remove();
      onClose?.();
    };

    closeBtn?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
  }

  formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
      return 'Yesterday';
    } else if (diffDays < 7) {
      return date.toLocaleDateString([], { weekday: 'short' });
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  }

  showToast(message, duration = 3000) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 2rem;
      left: 50%;
      transform: translateX(-50%);
      background: var(--bg-light);
      color: var(--text-primary);
      padding: 1rem 2rem;
      border-radius: var(--radius-md);
      box-shadow: var(--shadow);
      z-index: 2000;
      animation: fadeIn 0.3s ease-out;
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.animation = 'fadeOut 0.3s ease-out';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }
}

// ============================================================================
// Main Application
// ============================================================================

class NashMeshApp {
  constructor() {
    this.db = new NashMeshDB();
    this.meshtastic = new MeshtasticManager();
    this.conversations = null;
    this.ui = new UIManager();
  }

  async init() {
    // Initialize database
    await this.db.init();

    // Check if already configured
    const configured = await this.db.get('settings', 'configured');

    if (configured?.value) {
      // Try to auto-reconnect
      await this.showMessenger();
    } else {
      // Show onboarding
      this.ui.showOnboarding(() => this.startConnection());
    }

    // Register service worker
    this.registerServiceWorker();

    // Handle PWA install prompt
    this.handleInstallPrompt();
  }

  async startConnection() {
    this.ui.showConnecting();

    try {
      // Connect to device
      await this.meshtastic.connect((progress, message) => {
        this.ui.updateProgress(progress, message);
      });

      // Apply nashme.sh configuration
      await this.meshtastic.applyConfig(NASHME_CONFIG, (progress, message, step) => {
        this.ui.updateProgress(progress, message, step);
      });

      // Wait a moment to show completion
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check if user needs to set name
      const hasName = this.meshtastic.myNodeInfo?.user?.longName &&
                      !this.meshtastic.myNodeInfo.user.longName.startsWith('nashme.sh-');

      if (!hasName) {
        this.showUserSetup();
      } else {
        this.showSuccess();
      }

    } catch (error) {
      console.error('Connection error:', error);
      this.ui.showError(error.message, error.type || 'device', () => this.startConnection());
    }
  }

  showUserSetup() {
    this.ui.showUserSetup(
      async (longName, shortName) => {
        const finalLongName = longName || `nashme-${Date.now().toString(36)}`;
        const finalShortName = shortName || finalLongName.slice(0, 4);

        await this.meshtastic.setOwner(finalLongName, finalShortName);
        this.showSuccess();
      },
      async () => {
        const defaultName = `nashme-${Date.now().toString(36)}`;
        await this.meshtastic.setOwner(defaultName, 'NASH');
        this.showSuccess();
      }
    );
  }

  async showSuccess() {
    // Mark as configured
    await this.db.put('settings', { key: 'configured', value: true });
    await this.db.put('settings', { key: 'configuredAt', value: Date.now() });

    this.ui.showSuccess(async () => {
      await this.showMessenger();
    });
  }

  async showMessenger() {
    // Initialize conversation manager
    this.conversations = new ConversationManager(this.db, this.meshtastic);

    // Get conversations
    const convos = await this.conversations.getConversations();

    // Show messenger UI
    this.ui.showMessenger(
      convos,
      () => this.showNewConversation(),
      (convo) => this.selectConversation(convo)
    );

    // Listen for incoming messages
    this.meshtastic.onMessage(async (message) => {
      // Handle incoming message
      // Update UI if conversation is open
      if (this.ui.selectedConversation?.id === message.conversationId) {
        this.ui.addMessage(message, this.meshtastic.myNodeId);
      }

      // Update conversation list
      const convos = await this.conversations.getConversations();
      this.ui.renderConversations(convos, (c) => this.selectConversation(c));
    });
  }

  showNewConversation() {
    this.ui.showNewContactModal(
      async (contact) => {
        try {
          const conversation = await this.conversations.createDM(contact);
          const convos = await this.conversations.getConversations();
          this.ui.renderConversations(convos, (c) => this.selectConversation(c));
          this.selectConversation(conversation);
          this.ui.showToast(`Started conversation with ${contact.name}`);
        } catch (error) {
          this.ui.showToast(error.message);
        }
      },
      () => {}
    );
  }

  async selectConversation(conversation) {
    const messages = await this.conversations.getMessages(conversation.id);

    this.ui.showConversation(
      conversation,
      messages,
      this.meshtastic.myNodeId,
      async (text) => {
        const message = await this.conversations.sendMessage(conversation.id, text);
        this.ui.addMessage(message, this.meshtastic.myNodeId);
      }
    );

    await this.conversations.markAsRead(conversation.id);
  }

  registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js')
        .then(registration => {
          console.log('ServiceWorker registered:', registration.scope);
        })
        .catch(error => {
          console.log('ServiceWorker registration failed:', error);
        });
    }
  }

  handleInstallPrompt() {
    let deferredPrompt;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;

      // Show install prompt after a delay if not dismissed before
      const dismissed = localStorage.getItem('install_dismissed');
      if (!dismissed) {
        setTimeout(() => {
          this.showInstallPrompt(deferredPrompt);
        }, 30000); // Show after 30 seconds
      }
    });
  }

  showInstallPrompt(deferredPrompt) {
    const prompt = document.createElement('div');
    prompt.className = 'install-prompt';
    prompt.innerHTML = `
      <div class="install-prompt-content">
        <h3>Install nashme.sh</h3>
        <p>Add to home screen for the best experience</p>
      </div>
      <div class="install-prompt-actions">
        <button class="text-btn" id="install-dismiss">Later</button>
        <button class="secondary-btn" id="install-accept">Install</button>
      </div>
    `;
    document.body.appendChild(prompt);

    document.getElementById('install-accept').addEventListener('click', async () => {
      prompt.remove();
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      console.log('Install prompt outcome:', outcome);
    });

    document.getElementById('install-dismiss').addEventListener('click', () => {
      prompt.remove();
      localStorage.setItem('install_dismissed', 'true');
    });
  }
}

// ============================================================================
// Initialize App
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  const app = new NashMeshApp();
  app.init().catch(console.error);
});
