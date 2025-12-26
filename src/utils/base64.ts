/**
 * Base64 Encoding/Decoding Utilities
 *
 * Provides UTF-8 safe base64 encoding/decoding without using
 * the deprecated escape() and unescape() functions.
 *
 * @module utils/base64
 */

/**
 * Encode a UTF-8 string to base64.
 * Handles Unicode characters correctly.
 *
 * @param str - The string to encode
 * @returns Base64 encoded string
 */
export function encodeBase64(str: string): string {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(str);
	const binString = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join('');
	return btoa(binString);
}

/**
 * Decode a base64 string to UTF-8.
 * Handles Unicode characters correctly.
 *
 * @param base64 - The base64 string to decode
 * @returns Decoded UTF-8 string
 */
export function decodeBase64(base64: string): string {
	const binString = atob(base64);
	const bytes = Uint8Array.from(binString, (char) => char.codePointAt(0)!);
	const decoder = new TextDecoder();
	return decoder.decode(bytes);
}
