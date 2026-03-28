const base64chars =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];

    const triplet = (a << 16) | ((b || 0) << 8) | (c || 0);

    result += chars[(triplet >> 18) & 63];
    result += chars[(triplet >> 12) & 63];
    result += i + 1 < bytes.length ? chars[(triplet >> 6) & 63] : "=";
    result += i + 2 < bytes.length ? chars[triplet & 63] : "=";
  }

  return result;
}

function btoa(str: String) {
  let output = "";
  let i = 0;

  while (i < str.length) {
    const byte1 = str.charCodeAt(i++) & 0xff;
    const byte2 = i < str.length ? str.charCodeAt(i++) & 0xff : NaN;
    const byte3 = i < str.length ? str.charCodeAt(i++) & 0xff : NaN;

    const enc1 = byte1 >> 2;
    const enc2 = ((byte1 & 3) << 4) | (byte2 >> 4);
    const enc3 = ((byte2 & 15) << 2) | (byte3 >> 6);
    const enc4 = byte3 & 63;

    if (isNaN(byte2)) {
      output += base64chars[enc1] + base64chars[enc2] + "==";
    } else if (isNaN(byte3)) {
      output += base64chars[enc1] + base64chars[enc2] + base64chars[enc3] + "=";
    } else {
      output +=
        base64chars[enc1] +
        base64chars[enc2] +
        base64chars[enc3] +
        base64chars[enc4];
    }
  }

  return output;
}
