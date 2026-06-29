// Type augmentation for the WebRTC Encoded Transform / Insertable Streams API.
// These are non-standard (Chrome/Edge) and not part of the default TS DOM lib.

export interface RTCEncodedFrame {
  data: ArrayBuffer;
  timestamp: number;
}

export interface InsertableStreamPair {
  readable: ReadableStream<RTCEncodedFrame>;
  writable: WritableStream<RTCEncodedFrame>;
}

declare global {
  interface RTCRtpSender {
    createEncodedStreams?(): InsertableStreamPair;
  }
  interface RTCRtpReceiver {
    createEncodedStreams?(): InsertableStreamPair;
  }
  interface RTCConfiguration {
    encodedInsertableStreams?: boolean;
  }
}
