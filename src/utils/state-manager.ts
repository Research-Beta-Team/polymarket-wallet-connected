/**
 * Centralized state management utility
 * Provides single source of truth for UI state with change listeners
 */

type StateChangeListener<T> = (newState: T, oldState: T) => void;

/**
 * State manager class for managing application state
 */
export class StateManager<T extends Record<string, unknown>> {
  private state: T;
  private listeners: Map<keyof T, Set<StateChangeListener<T[keyof T]>>> = new Map();
  private globalListeners: Set<StateChangeListener<T>> = new Set();
  private updateQueue: Array<() => void> = [];
  private isUpdating = false;

  constructor(initialState: T) {
    this.state = { ...initialState };
  }

  /**
   * Get current state
   */
  getState(): T {
    return { ...this.state };
  }

  /**
   * Get a specific state property
   */
  get<K extends keyof T>(key: K): T[K] {
    return this.state[key];
  }

  /**
   * Update state (supports partial updates)
   * Queues updates to prevent race conditions
   */
  setState(updates: Partial<T>): void {
    if (this.isUpdating) {
      // Queue update if already updating
      this.updateQueue.push(() => this.setState(updates));
      return;
    }

    this.isUpdating = true;

    try {
      const oldState = { ...this.state };
      const changedKeys = new Set<keyof T>();

      // Apply updates
      for (const key in updates) {
        if (updates[key] !== this.state[key]) {
          this.state[key] = updates[key] as T[Extract<keyof T, string>];
          changedKeys.add(key);
        }
      }

      // Notify listeners for changed keys
      for (const key of changedKeys) {
        const listeners = this.listeners.get(key);
        if (listeners) {
          listeners.forEach(listener => {
            try {
              listener(this.state[key], oldState[key]);
            } catch (error) {
              console.error(`Error in state listener for ${String(key)}:`, error);
            }
          });
        }
      }

      // Notify global listeners if any key changed
      if (changedKeys.size > 0) {
        this.globalListeners.forEach(listener => {
          try {
            listener(this.state, oldState);
          } catch (error) {
            console.error('Error in global state listener:', error);
          }
        });
      }
    } finally {
      this.isUpdating = false;

      // Process queued updates
      while (this.updateQueue.length > 0) {
        const nextUpdate = this.updateQueue.shift();
        if (nextUpdate) {
          nextUpdate();
        }
      }
    }
  }

  /**
   * Subscribe to changes in a specific state property
   */
  subscribe<K extends keyof T>(
    key: K,
    listener: (newValue: T[K], oldValue: T[K]) => void
  ): () => void {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    const wrappedListener = (newVal: T[keyof T], oldVal: T[keyof T]) => {
      if (newVal !== oldVal) {
        listener(newVal as T[K], oldVal as T[K]);
      }
    };
    this.listeners.get(key)!.add(wrappedListener as StateChangeListener<T[keyof T]>);

    // Return unsubscribe function
    return () => {
      const listeners = this.listeners.get(key);
      if (listeners) {
        listeners.delete(wrappedListener as StateChangeListener<T[keyof T]>);
        if (listeners.size === 0) {
          this.listeners.delete(key);
        }
      }
    };
  }

  /**
   * Subscribe to all state changes
   */
  subscribeAll(listener: StateChangeListener<T>): () => void {
    this.globalListeners.add(listener);

    // Return unsubscribe function
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  /**
   * Batch multiple state updates (prevents multiple notifications)
   */
  batchUpdate(updates: Partial<T>): void {
    this.setState(updates);
  }

  /**
   * Reset state to initial values
   */
  reset(initialState: T): void {
    const oldState = { ...this.state };
    this.state = { ...initialState };

    // Notify all listeners
    for (const [key, listeners] of this.listeners.entries()) {
      listeners.forEach(listener => {
        try {
          listener(this.state[key], oldState[key]);
        } catch (error) {
          console.error(`Error in state listener for ${String(key)}:`, error);
        }
      });
    }

    this.globalListeners.forEach(listener => {
      try {
        listener(this.state, oldState);
      } catch (error) {
        console.error('Error in global state listener:', error);
      }
    });
  }

  /**
   * Check if state has a specific property
   */
  has(key: keyof T): boolean {
    return key in this.state;
  }
}

/**
 * Application state interface
 */
export interface AppState extends Record<string, unknown> {
  // Connection state
  connectionStatus: {
    connected: boolean;
    source: string | null;
    lastUpdate: number | null;
    error: string | null;
  };

  // Price state
  currentPrice: number | null;
  upPrice: number | null;
  downPrice: number | null;
  priceHistory: Array<{ timestamp: number; value: number }>;

  // Wallet state
  wallet: {
    eoaAddress: string | null;
    proxyAddress: string | null;
    isConnected: boolean;
    isLoading: boolean;
    error: string | null;
    isInitialized: boolean;
    balance: number | null;
    balanceLoading: boolean;
    apiCredentials: { key: string; secret: string; passphrase: string } | null;
  };

  // UI state
  ui: {
    eventsLoading: boolean;
    ordersLoading: boolean;
    tradingSectionRendered: boolean;
    walletSectionRendered: boolean;
  };

  // Event state (stored as arrays for serialization, converted to Maps when needed)
  eventPriceToBeat: Array<[string, number]>;
  eventLastPrice: Array<[string, number]>;
}

/**
 * Create initial application state
 */
export function createInitialAppState(): AppState {
  return {
    connectionStatus: {
      connected: false,
      source: null,
      lastUpdate: null,
      error: null,
    },
    currentPrice: null,
    upPrice: null,
    downPrice: null,
    priceHistory: [],
    wallet: {
      eoaAddress: null,
      proxyAddress: null,
      isConnected: false,
      isLoading: false,
      error: null,
      isInitialized: false,
      balance: null,
      balanceLoading: false,
      apiCredentials: null,
    },
    ui: {
      eventsLoading: false,
      ordersLoading: false,
      tradingSectionRendered: false,
      walletSectionRendered: false,
    },
    eventPriceToBeat: [],
    eventLastPrice: [],
  };
}

/**
 * Convert array of tuples to Map
 */
export function arrayToMap(arr: Array<[string, number]>): Map<string, number> {
  return new Map(arr);
}

/**
 * Convert Map to array of tuples
 */
export function mapToArray(map: Map<string, number>): Array<[string, number]> {
  return Array.from(map.entries());
}

/**
 * Helper to get Map from state array
 */
export function getEventPriceMap(state: AppState, key: 'eventPriceToBeat' | 'eventLastPrice'): Map<string, number> {
  return arrayToMap(state[key] as Array<[string, number]>);
}

/**
 * Helper to update Map in state
 */
export function setEventPriceMap(stateManager: StateManager<AppState>, key: 'eventPriceToBeat' | 'eventLastPrice', map: Map<string, number>): void {
  stateManager.setState({
    [key]: mapToArray(map),
  } as Partial<AppState>);
}
