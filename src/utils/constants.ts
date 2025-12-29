/**
 * Constants used throughout the Perspecta plugin
 */

export const TIMING = {
	// Window chrome configuration delays (in ms)
	CHROME_RETRY_DELAY_1: 50,
	CHROME_RETRY_DELAY_2: 150,
	CHROME_RETRY_DELAY_3: 300,
	
	// External store debounce delay (in ms)
	EXTERNAL_STORE_DEBOUNCE: 2000,
	
	// UI delays (in ms)
	INDICATORS_REFRESH_DELAY: 500,
	WINDOW_SPLIT_DELAY: 100,
	SCROLL_RESTORATION_DELAY: 200,
	TAB_ACTIVATION_DELAY: 100,
	BRIEF_PAUSE_DELAY: 50,
	
	// Window restore delays (in ms)
	RESTORE_PAUSE_SHORT: 100,
	RESTORE_PAUSE_LONG: 200,
} as const;

export const LIMITS = {
	MAX_POPOUT_WINDOWS: 20,
	MAX_ARRANGEMENTS_PER_NOTE: 50,
	MIN_PROXY_PREVIEW_SCALE: 0.1,
	MAX_PROXY_PREVIEW_SCALE: 1.0,
	MIN_FOCUS_TINT_DURATION: 0,
	MAX_FOCUS_TINT_DURATION: 60,
} as const;

export const CSS_CLASSES = {
	PROXY_WINDOW: 'perspecta-proxy-window',
	PROXY_WORKSPACE: 'perspecta-proxy-workspace',
	PROXY_HEADER: 'perspecta-proxy-header',
	PROXY_TITLE: 'perspecta-proxy-title',
	PROXY_EXPAND: 'perspecta-proxy-expand',
	PROXY_PREVIEW_WRAPPER: 'perspecta-proxy-preview-wrapper',
	PROXY_PREVIEW_CONTENT: 'perspecta-proxy-preview-content',
	CONTEXT_INDICATOR: 'perspecta-context-indicator',
} as const;

export const EVENTS = {
	FOCUS: 'focus',
	CLICK: 'click',
	MOUSE_DOWN: 'mousedown',
	MOUSE_ENTER: 'mouseenter',
	MOUSE_LEAVE: 'mouseleave',
	KEY_DOWN: 'keydown',
	MOUSE_OVER: 'mouseover',
	MOUSE_OUT: 'mouseout',
} as const;
