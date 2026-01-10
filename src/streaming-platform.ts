import { WebSocketClient } from './websocket-client';
import { EventManager } from './event-manager';
import { TradingManager } from './trading-manager';
import { getNext15MinIntervals } from './event-utils';
import type { PriceUpdate, ConnectionStatus } from './types';

export class StreamingPlatform {
  private wsClient: WebSocketClient;
  private eventManager: EventManager;
  private tradingManager: TradingManager;
  private currentPrice: number | null = null;
  private priceHistory: Array<{ timestamp: number; value: number }> = [];
  private maxHistorySize = 100;
  private currentStatus: ConnectionStatus = {
    connected: false,
    source: null,
    lastUpdate: null,
    error: null
  };
  private countdownInterval: number | null = null;
  private eventPriceToBeat: Map<string, number> = new Map(); // Map of event slug to price to beat
  private eventLastPrice: Map<string, number> = new Map(); // Map of event slug to last price (from previous event end)
  private upPrice: number | null = null; // Current UP token price (0-100 scale)
  private downPrice: number | null = null; // Current DOWN token price (0-100 scale)
  private priceUpdateInterval: number | null = null; // Interval for updating UP/DOWN prices

  constructor() {
    this.wsClient = new WebSocketClient();
    this.eventManager = new EventManager();
    this.tradingManager = new TradingManager();
    this.eventManager.setOnEventsUpdated(() => {
      this.renderEventsTable();
    });
    this.wsClient.setCallbacks(
      this.handlePriceUpdate.bind(this),
      this.handleStatusChange.bind(this)
    );
    this.tradingManager.setOnStatusUpdate(() => {
      this.renderTradingSection();
    });
    this.tradingManager.setOnTradeUpdate(() => {
      this.renderTradingSection();
    });
    this.tradingManager.loadStrategyConfig();
  }

  async initialize(): Promise<void> {
    this.render();
    this.setupEventListeners();
    await this.loadEvents();
    this.eventManager.startAutoRefresh(60000); // Refresh every minute
    this.renderTradingSection(); // Initialize trading section UI
    this.startPriceUpdates(); // Start updating UP/DOWN prices
  }

  private setupEventListeners(): void {
    const connectBtn = document.getElementById('connect');
    const disconnectBtn = document.getElementById('disconnect');

    connectBtn?.addEventListener('click', () => {
      this.wsClient.connect();
    });

    disconnectBtn?.addEventListener('click', () => {
      this.wsClient.disconnect();
      this.currentStatus = {
        connected: false,
        source: null,
        lastUpdate: null,
        error: null
      };
      this.updateUI();
    });

    // Trading controls
    const startTradingBtn = document.getElementById('start-trading');
    const stopTradingBtn = document.getElementById('stop-trading');
    const saveStrategyBtn = document.getElementById('save-strategy');
    const clearTradesBtn = document.getElementById('clear-trades');

    startTradingBtn?.addEventListener('click', () => {
      this.tradingManager.startTrading();
      this.renderTradingSection();
    });

    stopTradingBtn?.addEventListener('click', () => {
      this.tradingManager.stopTrading();
      this.renderTradingSection();
    });

    saveStrategyBtn?.addEventListener('click', () => {
      this.saveStrategyConfig();
    });

    clearTradesBtn?.addEventListener('click', () => {
      if (confirm('Are you sure you want to clear all trades? This cannot be undone.')) {
        this.tradingManager.clearTrades();
        this.renderTradingSection();
      }
    });
  }

  private handlePriceUpdate(update: PriceUpdate): void {
    this.currentPrice = update.payload.value;
    this.priceHistory.push({
      timestamp: update.payload.timestamp,
      value: update.payload.value
    });

    if (this.priceHistory.length > this.maxHistorySize) {
      this.priceHistory.shift();
    }

    // Check if we need to capture price for a newly active event
    this.capturePriceForActiveEvent();
    
    // Check if an event just expired and capture the price for the next event
    this.capturePriceForExpiredEvent();

    // Update trading manager with current market data
    this.updateTradingManager();

    this.updatePriceDisplay();
  }

  private capturePriceForExpiredEvent(): void {
    if (this.currentPrice === null) return;

    const events = this.eventManager.getEvents();
    
    // For each event, check if the previous event just expired
    events.forEach((event, index) => {
      if (index > 0) {
        const previousEvent = events[index - 1];
        
        // If previous event is expired and we haven't stored the last price for this event yet
        if (previousEvent.status === 'expired' && !this.eventLastPrice.has(event.slug) && this.currentPrice !== null) {
          // Store the current price as the last price (price when previous event ended)
          this.eventLastPrice.set(event.slug, this.currentPrice);
          // Re-render to show the last price
          this.renderEventsTable();
        }
      }
    });
  }

  private capturePriceForActiveEvent(): void {
    if (this.currentPrice === null) return;

    const events = this.eventManager.getEvents();
    const activeEvent = events.find(e => e.status === 'active');
    
    if (activeEvent) {
      // If we don't have a price to beat for this event yet, capture it
      if (!this.eventPriceToBeat.has(activeEvent.slug)) {
        this.eventPriceToBeat.set(activeEvent.slug, this.currentPrice);
        // Re-render active event to show the price
        this.renderActiveEvent();
      }
    }
  }

  private handleStatusChange(status: ConnectionStatus): void {
    this.currentStatus = status;
    this.updateUI();
  }

  private updatePriceDisplay(): void {
    const priceElement = document.getElementById('current-price');
    const timestampElement = document.getElementById('price-timestamp');
    const changeElement = document.getElementById('price-change');

    if (priceElement && this.currentPrice !== null) {
      priceElement.textContent = this.formatPrice(this.currentPrice);
      
      // Add animation class for price updates
      priceElement.classList.add('price-update');
      setTimeout(() => {
        priceElement.classList.remove('price-update');
      }, 300);
    }

    if (timestampElement && this.priceHistory.length > 0) {
      const lastUpdate = this.priceHistory[this.priceHistory.length - 1];
      timestampElement.textContent = new Date(lastUpdate.timestamp).toLocaleTimeString();
    }

    if (changeElement && this.priceHistory.length >= 2) {
      const current = this.priceHistory[this.priceHistory.length - 1].value;
      const previous = this.priceHistory[this.priceHistory.length - 2].value;
      const change = current - previous;
      const changePercentValue = (change / previous) * 100;
      const changePercent = changePercentValue.toFixed(4);

      changeElement.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)} (${changePercentValue >= 0 ? '+' : ''}${changePercent}%)`;
      changeElement.className = change >= 0 ? 'positive' : 'negative';
    }
  }

  private updateUI(): void {
    const statusElement = document.getElementById('connection-status');
    const errorElement = document.getElementById('error-message');
    
    if (statusElement) {
      const isConnected = this.currentStatus.connected;
      statusElement.textContent = isConnected ? 'Connected' : 'Disconnected';
      statusElement.className = isConnected ? 'status-connected' : 'status-disconnected';
    }

    if (errorElement) {
      errorElement.textContent = this.currentStatus.error || '';
    }
  }

  private formatPrice(price: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(price);
  }

  /**
   * Format UP/DOWN price (0-100 scale) as cents
   */
  private formatUpDownPrice(price: number): string {
    // Price is in 0-100 scale, convert to cents (0-10000)
    const cents = Math.round(price);
    return `${cents}¢`;
  }

  private async loadEvents(): Promise<void> {
    try {
      await this.eventManager.loadEvents(10);
      
      // Update last prices when events are loaded
      this.updateLastPrices();
      
      this.renderEventsTable();
      // Clear any previous errors
      const errorElement = document.getElementById('events-error');
      if (errorElement) {
        errorElement.textContent = '';
      }
    } catch (error) {
      console.error('Error loading events:', error);
      const errorElement = document.getElementById('events-error');
      if (errorElement) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errorElement.textContent = `Failed to load events: ${errorMessage}`;
        errorElement.style.display = 'block';
      }
      
      // Still try to render with placeholder data if we have timestamps
      const timestamps = getNext15MinIntervals(10);
      if (timestamps.length > 0) {
        this.updateLastPrices();
        this.renderEventsTable();
      }
    }
  }

  private updateLastPrices(): void {
    if (this.currentPrice === null) return;

    const events = this.eventManager.getEvents();
    
    // For each event, if the previous event just expired, capture the price
    events.forEach((event, index) => {
      if (index > 0) {
        const previousEvent = events[index - 1];
        
        // If previous event is expired and we have a current price, store it as last price for this event
        if (previousEvent.status === 'expired' && !this.eventLastPrice.has(event.slug) && this.currentPrice !== null) {
          // Use current price as the last price (price when previous event ended)
          this.eventLastPrice.set(event.slug, this.currentPrice);
        }
      }
    });
  }

  private formatCountdown(seconds: number): string {
    if (seconds <= 0) {
      return '00:00:00';
    }
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }

  private updateCountdown(): void {
    const events = this.eventManager.getEvents();
    const activeEvent = events.find(e => e.status === 'active');
    const countdownElement = document.getElementById('event-countdown');
    
    if (!activeEvent || !countdownElement) {
      this.stopCountdown();
      return;
    }

    const endDate = new Date(activeEvent.endDate);
    const now = new Date();
    const timeLeft = Math.max(0, Math.floor((endDate.getTime() - now.getTime()) / 1000));
    
    countdownElement.textContent = this.formatCountdown(timeLeft);
    
    // If time is up, capture the price and refresh events to update status
    if (timeLeft === 0) {
      // Capture current price as last price for the next event
      if (this.currentPrice !== null) {
        const events = this.eventManager.getEvents();
        const activeEvent = events.find(e => e.status === 'active');
        if (activeEvent) {
          const activeIndex = events.findIndex(e => e.status === 'active');
          const nextEvent = events[activeIndex + 1];
          if (nextEvent && !this.eventLastPrice.has(nextEvent.slug)) {
            this.eventLastPrice.set(nextEvent.slug, this.currentPrice);
          }
        }
      }
      this.stopCountdown();
      this.loadEvents().catch(console.error);
    }
  }

  private startCountdown(): void {
    this.stopCountdown();
    this.countdownInterval = window.setInterval(() => {
      this.updateCountdown();
    }, 1000);
    // Update immediately
    this.updateCountdown();
  }

  private stopCountdown(): void {
    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  /**
   * Fetch UP and DOWN prices for the active event
   */
  private async updateUpDownPrices(): Promise<void> {
    const events = this.eventManager.getEvents();
    const activeEvent = events.find(e => e.status === 'active');

    if (!activeEvent || !activeEvent.clobTokenIds || activeEvent.clobTokenIds.length < 2) {
      this.upPrice = null;
      this.downPrice = null;
      // Update DOM to show no prices
      this.updateUpDownPriceDisplay();
      return;
    }

    const upTokenId = activeEvent.clobTokenIds[0]; // First token = UP
    const downTokenId = activeEvent.clobTokenIds[1]; // Second token = DOWN

    try {
      // Fetch prices in parallel using proxy to avoid CORS issues
      const [upPriceResult, downPriceResult] = await Promise.all([
        fetch(`/api/clob-proxy?side=BUY&token_id=${upTokenId}`),
        fetch(`/api/clob-proxy?side=BUY&token_id=${downTokenId}`),
      ]);

      // Check if response is actually JSON (not TypeScript source)
      if (upPriceResult.ok) {
        const contentType = upPriceResult.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const upData = await upPriceResult.json();
          this.upPrice = upData.price ? parseFloat(upData.price) * 100 : null; // Convert to 0-100 scale
        } else {
          console.warn('UP price response is not JSON, trying direct API call');
          // Try direct API call as fallback
          await this.fetchPriceDirectly(upTokenId, 'up');
        }
      }

      if (downPriceResult.ok) {
        const contentType = downPriceResult.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const downData = await downPriceResult.json();
          this.downPrice = downData.price ? parseFloat(downData.price) * 100 : null; // Convert to 0-100 scale
        } else {
          console.warn('DOWN price response is not JSON, trying direct API call');
          // Try direct API call as fallback
          await this.fetchPriceDirectly(downTokenId, 'down');
        }
      }

      // Update DOM elements directly for smoother updates
      this.updateUpDownPriceDisplay();
    } catch (error) {
      console.error('Error fetching UP/DOWN prices:', error);
      // Fallback to direct API calls if proxy fails
      try {
        if (upTokenId) await this.fetchPriceDirectly(upTokenId, 'up');
        if (downTokenId) await this.fetchPriceDirectly(downTokenId, 'down');
      } catch (fallbackError) {
        console.error('Fallback price fetch also failed:', fallbackError);
      }
    }
  }

  /**
   * Fallback: Fetch price directly from CLOB API (if proxy fails)
   */
  private async fetchPriceDirectly(tokenId: string, type: 'up' | 'down'): Promise<void> {
    try {
      // Use CORS proxy or direct call
      const response = await fetch(`https://clob.polymarket.com/price?side=BUY&token_id=${tokenId}`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
        mode: 'cors',
      });

      if (response.ok) {
        const data = await response.json();
        const price = data.price ? parseFloat(data.price) * 100 : null;
        if (type === 'up') {
          this.upPrice = price;
        } else {
          this.downPrice = price;
        }
        this.updateUpDownPriceDisplay();
      }
    } catch (error) {
      console.error(`Error fetching ${type} price directly:`, error);
    }
  }

  /**
   * Update UP/DOWN price display in DOM without re-rendering entire section
   */
  private updateUpDownPriceDisplay(): void {
    const upPriceElement = document.getElementById('up-price-value');
    const downPriceElement = document.getElementById('down-price-value');

    if (upPriceElement) {
      upPriceElement.textContent = this.upPrice !== null ? this.formatUpDownPrice(this.upPrice) : '--';
      // Add animation class
      upPriceElement.classList.add('price-update');
      setTimeout(() => {
        upPriceElement.classList.remove('price-update');
      }, 300);
    }

    if (downPriceElement) {
      downPriceElement.textContent = this.downPrice !== null ? this.formatUpDownPrice(this.downPrice) : '--';
      // Add animation class
      downPriceElement.classList.add('price-update');
      setTimeout(() => {
        downPriceElement.classList.remove('price-update');
      }, 300);
    }
  }

  /**
   * Start updating UP/DOWN prices in real-time
   */
  private startPriceUpdates(): void {
    this.stopPriceUpdates();
    // Update immediately
    this.updateUpDownPrices();
    // Then update every 1 second
    this.priceUpdateInterval = window.setInterval(() => {
      this.updateUpDownPrices();
    }, 1000);
  }

  /**
   * Stop updating UP/DOWN prices
   */
  private stopPriceUpdates(): void {
    if (this.priceUpdateInterval !== null) {
      clearInterval(this.priceUpdateInterval);
      this.priceUpdateInterval = null;
    }
  }

  private renderActiveEvent(): void {
    const events = this.eventManager.getEvents();
    const activeEvent = events.find(e => e.status === 'active');
    const activeEventContainer = document.getElementById('active-event-display');
    
    if (!activeEventContainer) return;

    // Stop countdown if no active event
    if (!activeEvent) {
      this.stopCountdown();
      activeEventContainer.innerHTML = `
        <div class="active-event-empty">
          <p>No active event at the moment</p>
        </div>
      `;
      return;
    }

    // Get price to beat for this event
    const priceToBeat = this.eventPriceToBeat.get(activeEvent.slug);
    const priceToBeatDisplay = priceToBeat !== undefined 
      ? this.formatPrice(priceToBeat) 
      : (this.currentPrice !== null ? this.formatPrice(this.currentPrice) + ' (current)' : 'Loading...');

    // If we have a current price but no stored price to beat, capture it now
    if (priceToBeat === undefined && this.currentPrice !== null) {
      this.eventPriceToBeat.set(activeEvent.slug, this.currentPrice);
    }

    activeEventContainer.innerHTML = `
      <div class="active-event-content">
        <div class="active-event-header">
          <span class="active-event-badge">ACTIVE EVENT</span>
          <span class="active-event-status">LIVE</span>
        </div>
        <div class="active-event-title">${activeEvent.title}</div>
        <div class="active-event-countdown">
          <span class="countdown-label">Time Remaining:</span>
          <span class="countdown-value" id="event-countdown">--:--:--</span>
        </div>
        <div class="active-event-price-to-beat">
          <span class="price-to-beat-label">Price to Beat:</span>
          <span class="price-to-beat-value">${priceToBeatDisplay}</span>
        </div>
        <div class="active-event-up-down-prices">
          <button class="up-down-button up-button" id="up-price-button">
            <span class="button-label">Up</span>
            <span class="button-price" id="up-price-value">${this.upPrice !== null ? this.formatUpDownPrice(this.upPrice) : '--'}</span>
          </button>
          <button class="up-down-button down-button" id="down-price-button">
            <span class="button-label">Down</span>
            <span class="button-price" id="down-price-value">${this.downPrice !== null ? this.formatUpDownPrice(this.downPrice) : '--'}</span>
          </button>
        </div>
        <div class="active-event-details">
          <div class="active-event-detail-item">
            <span class="detail-label">Start:</span>
            <span class="detail-value">${activeEvent.formattedStartDate}</span>
          </div>
          <div class="active-event-detail-item">
            <span class="detail-label">End:</span>
            <span class="detail-value">${activeEvent.formattedEndDate}</span>
          </div>
        </div>
        <div class="active-event-info">
          <div class="info-row">
            <span class="info-label">Condition ID:</span>
            <span class="info-value">${activeEvent.conditionId || '--'}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Question ID:</span>
            <span class="info-value">${activeEvent.questionId || '--'}</span>
          </div>
          <div class="info-row">
            <span class="info-label">CLOB Token IDs:</span>
            <span class="info-value">${activeEvent.clobTokenIds ? activeEvent.clobTokenIds.join(', ') : '--'}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Slug:</span>
            <span class="info-value slug-value">${activeEvent.slug}</span>
          </div>
        </div>
      </div>
    `;

    // Start countdown for active event
    this.startCountdown();
    
    // Update prices if we have token IDs
    if (activeEvent.clobTokenIds && activeEvent.clobTokenIds.length >= 2) {
      this.updateUpDownPrices();
    }
  }

  private renderEventsTable(): void {
    const events = this.eventManager.getEvents();
    const currentIndex = this.eventManager.getCurrentEventIndex();
    const tableBody = document.getElementById('events-table-body');
    
    if (!tableBody) return;

    // Capture price for newly active events
    this.capturePriceForActiveEvent();

    // Also update active event display
    this.renderActiveEvent();

    if (events.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px;">No events found</td></tr>';
      return;
    }

    tableBody.innerHTML = events.map((event, index) => {
      const isCurrent = index === currentIndex;
      const rowClass = isCurrent ? 'event-row current-event' : 'event-row';
      
      const statusClass = event.status === 'active' ? 'status-active' : 
                          event.status === 'expired' ? 'status-expired' : 'status-upcoming';
      const statusText = event.status === 'active' ? 'Active' : 
                        event.status === 'expired' ? 'Expired' : 'Upcoming';

      // Get last price for this event (from previous event's end)
      const lastPrice = this.eventLastPrice.get(event.slug) || event.lastPrice;
      const lastPriceDisplay = lastPrice !== undefined ? this.formatPrice(lastPrice) : '--';

      return `
        <tr class="${rowClass}">
          <td>${event.title}</td>
          <td>${event.formattedStartDate}</td>
          <td>${event.formattedEndDate}</td>
          <td><span class="${statusClass}">${statusText}</span></td>
          <td>${lastPriceDisplay}</td>
          <td>${event.conditionId || '--'}</td>
          <td>${event.questionId || '--'}</td>
          <td>${event.clobTokenIds ? event.clobTokenIds.join(', ') : '--'}</td>
          <td>${event.slug}</td>
        </tr>
      `;
    }).join('');
  }

  private render(): void {
    const app = document.getElementById('app');
    if (!app) return;

    app.innerHTML = `
      <div class="container">
        <header>
          <h1>BTC/USD Streaming Platform</h1>
          <p class="subtitle">Real-time cryptocurrency price data from Polymarket</p>
        </header>

        <div class="controls">
          <div class="button-group">
            <button id="connect" class="btn btn-primary">Connect</button>
            <button id="disconnect" class="btn btn-secondary">Disconnect</button>
          </div>
        </div>

        <div class="status-bar">
          <div class="status-item">
            <span class="status-label">Status:</span>
            <span id="connection-status" class="status-disconnected">Disconnected</span>
          </div>
          <div id="error-message" class="error-message"></div>
        </div>

        <div class="price-display">
          <div class="price-label">Current Price</div>
          <div id="current-price" class="price-value">--</div>
          <div class="price-meta">
            <span>Last Update: <span id="price-timestamp">--</span></span>
            <span id="price-change" class="price-change">--</span>
          </div>
        </div>

        <div class="active-event-section" id="active-event-display">
          <div class="active-event-empty">
            <p>Loading events...</p>
          </div>
        </div>

        <div class="events-section">
          <h2>BTC Up/Down 15m Events</h2>
          <div id="events-error" class="error-message"></div>
          <div class="events-table-container">
            <table class="events-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Start Date</th>
                  <th>End Date</th>
                  <th>Status</th>
                  <th>Price to Beat</th>
                  <th>Condition ID</th>
                  <th>Question ID</th>
                  <th>CLOB Token IDs</th>
                  <th>Slug</th>
                </tr>
              </thead>
              <tbody id="events-table-body">
                <tr>
                  <td colspan="9" style="text-align: center; padding: 20px;">Loading events...</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="trading-section" id="trading-section">
          <h2>Automated Trading</h2>
          <div class="trading-controls">
            <div class="strategy-config">
              <h3>Strategy Configuration</h3>
              <div class="config-grid">
                <div class="config-item">
                  <label>
                    <input type="checkbox" id="strategy-enabled" />
                    Enable Strategy
                  </label>
                </div>
                <div class="config-item">
                  <label>
                    Entry Price (0-100):
                    <input type="number" id="entry-price" value="96" min="0" max="100" step="0.01" />
                    <small>Limit order will be placed at this price</small>
                  </label>
                </div>
                <div class="config-item">
                  <label>
                    Profit Target (0-100):
                    <input type="number" id="profit-target-price" value="100" min="0" max="100" step="0.01" />
                    <small>Sell when price reaches this level</small>
                  </label>
                </div>
                <div class="config-item">
                  <label>
                    Stop Loss (0-100):
                    <input type="number" id="stop-loss-price" value="91" min="0" max="100" step="0.01" />
                    <small>Sell when price drops to this level</small>
                  </label>
                </div>
                <div class="config-item">
                  <label>
                    Trade Size (USD):
                    <input type="number" id="trade-size" value="50" min="0" step="0.01" />
                  </label>
                </div>
                <div class="config-item">
                  <label>
                    <small>Direction: Automatically determined (UP or DOWN, whichever reaches entry price first)</small>
                  </label>
                </div>
              </div>
              <div class="config-actions">
                <button id="save-strategy" class="btn btn-primary">Save Strategy</button>
              </div>
            </div>
            <div class="trading-status-panel">
              <h3>Trading Status</h3>
              <div id="trading-status-display"></div>
              <div class="trading-actions">
                <button id="start-trading" class="btn btn-primary">Start Trading</button>
                <button id="stop-trading" class="btn btn-secondary">Stop Trading</button>
                <button id="clear-trades" class="btn btn-secondary">Clear Trades</button>
              </div>
            </div>
          </div>
          <div class="trades-history">
            <h3>Trade History</h3>
            <div id="trades-table-container"></div>
          </div>
        </div>

        <div class="info-section">
          <h2>About</h2>
          <p>This platform streams real-time BTC/USD price data from Polymarket's Real-Time Data Socket (RTDS).</p>
          <p>The data is sourced from Chainlink oracle networks, providing reliable and accurate Bitcoin price information.</p>
        </div>
      </div>
    `;
  }

  private updateTradingManager(): void {
    const events = this.eventManager.getEvents();
    const activeEvent = events.find(e => e.status === 'active');
    const priceToBeat = activeEvent ? this.eventPriceToBeat.get(activeEvent.slug) : null;

    this.tradingManager.updateMarketData(
      this.currentPrice,
      priceToBeat || null,
      activeEvent || null
    );
  }

  private saveStrategyConfig(): void {
    const enabled = (document.getElementById('strategy-enabled') as HTMLInputElement)?.checked || false;
    const entryPrice = parseFloat((document.getElementById('entry-price') as HTMLInputElement)?.value || '96');
    const profitTargetPrice = parseFloat((document.getElementById('profit-target-price') as HTMLInputElement)?.value || '100');
    const stopLossPrice = parseFloat((document.getElementById('stop-loss-price') as HTMLInputElement)?.value || '91');
    const tradeSize = parseFloat((document.getElementById('trade-size') as HTMLInputElement)?.value || '50');

    this.tradingManager.setStrategyConfig({
      enabled,
      entryPrice,
      profitTargetPrice,
      stopLossPrice,
      tradeSize,
    });

    alert('Strategy configuration saved!');
  }

  private renderTradingSection(): void {
    const status = this.tradingManager.getStatus();
    const config = this.tradingManager.getStrategyConfig();
    const trades = this.tradingManager.getTrades();

    // Update strategy config inputs
    const enabledInput = document.getElementById('strategy-enabled') as HTMLInputElement;
    const entryPriceInput = document.getElementById('entry-price') as HTMLInputElement;
    const profitTargetPriceInput = document.getElementById('profit-target-price') as HTMLInputElement;
    const stopLossPriceInput = document.getElementById('stop-loss-price') as HTMLInputElement;
    const tradeSizeInput = document.getElementById('trade-size') as HTMLInputElement;

    if (enabledInput) enabledInput.checked = config.enabled;
    if (entryPriceInput) entryPriceInput.value = config.entryPrice.toString();
    if (profitTargetPriceInput) profitTargetPriceInput.value = config.profitTargetPrice.toString();
    if (stopLossPriceInput) stopLossPriceInput.value = config.stopLossPrice.toString();
    if (tradeSizeInput) tradeSizeInput.value = config.tradeSize.toString();

    // Update trading status display
    const statusDisplay = document.getElementById('trading-status-display');
    if (statusDisplay) {
      const positionInfo = status.currentPosition
        ? `
          <div class="position-info">
            <h4>Current Position</h4>
            <div class="position-details">
              <div><strong>Event:</strong> ${status.currentPosition.eventSlug}</div>
              <div><strong>Direction:</strong> ${status.currentPosition.direction || 'N/A'}</div>
              <div><strong>Side:</strong> ${status.currentPosition.side}</div>
              <div><strong>Entry Price:</strong> ${status.currentPosition.entryPrice.toFixed(2)}</div>
              <div><strong>Size:</strong> $${status.currentPosition.size.toFixed(2)}</div>
              ${status.currentPosition.currentPrice !== undefined ? `<div><strong>Current Price:</strong> ${status.currentPosition.currentPrice.toFixed(2)}</div>` : ''}
              ${status.currentPosition.unrealizedProfit !== undefined ? `<div class="${status.currentPosition.unrealizedProfit >= 0 ? 'profit' : 'loss'}"><strong>Unrealized P/L:</strong> $${status.currentPosition.unrealizedProfit.toFixed(2)}</div>` : ''}
            </div>
          </div>
        `
        : '<div class="no-position">No open position</div>';

      statusDisplay.innerHTML = `
        <div class="status-summary">
          <div class="status-item">
            <span class="status-label">Trading Status:</span>
            <span class="${status.isActive ? 'status-active' : 'status-inactive'}">
              ${status.isActive ? 'ACTIVE' : 'INACTIVE'}
            </span>
          </div>
          <div class="status-item">
            <span class="status-label">Total Trades:</span>
            <span class="status-value">${status.totalTrades}</span>
          </div>
          <div class="status-item">
            <span class="status-label">Successful:</span>
            <span class="status-value success">${status.successfulTrades}</span>
          </div>
          <div class="status-item">
            <span class="status-label">Failed:</span>
            <span class="status-value failed">${status.failedTrades}</span>
          </div>
          <div class="status-item">
            <span class="status-label">Total Profit:</span>
            <span class="status-value ${status.totalProfit >= 0 ? 'profit' : 'loss'}">
              $${status.totalProfit.toFixed(2)}
            </span>
          </div>
          <div class="status-item">
            <span class="status-label">Pending Orders:</span>
            <span class="status-value">${status.pendingLimitOrders}</span>
          </div>
        </div>
        ${positionInfo}
      `;
    }

    // Update trades table
    const tradesContainer = document.getElementById('trades-table-container');
    if (tradesContainer) {
      if (trades.length === 0) {
        tradesContainer.innerHTML = '<p class="no-trades">No trades yet</p>';
      } else {
        tradesContainer.innerHTML = `
          <table class="trades-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Side</th>
                <th>Size</th>
                <th>Price</th>
                <th>Status</th>
                <th>Profit</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              ${trades.slice().reverse().map(trade => `
                <tr class="trade-row trade-${trade.status}">
                  <td>${new Date(trade.timestamp).toLocaleTimeString()}</td>
                  <td class="event-slug">${trade.eventSlug}</td>
                  <td><span class="side-${trade.side.toLowerCase()}">${trade.side}</span> ${trade.direction ? `<span class="direction-badge direction-${trade.direction.toLowerCase()}">${trade.direction}</span>` : ''}</td>
                  <td>$${trade.size.toFixed(2)}</td>
                  <td>${trade.price.toFixed(2)}${trade.orderType === 'LIMIT' && trade.limitPrice ? ` (limit: ${trade.limitPrice.toFixed(2)})` : ''}</td>
                  <td><span class="status-badge status-${trade.status}">${trade.status}</span> ${trade.orderType === 'LIMIT' ? '<span class="order-type">LIMIT</span>' : ''}</td>
                  <td class="${trade.profit !== undefined ? (trade.profit >= 0 ? 'profit' : 'loss') : ''}">
                    ${trade.profit !== undefined ? `$${trade.profit.toFixed(2)}` : '--'}
                  </td>
                  <td class="reason">${trade.reason}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      }
    }
  }
}

