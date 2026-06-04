// Stub of the easymidi surface used by lidal — Output { send, close } and
// Input { on, close }. Aliased in by esbuild when building the headless
// bundle so CI doesn't need the native @julusian/midi prebuilds.

class Output {
  constructor(name, _virtual) { this.name = name; }
  send(_event, _payload) { /* no-op */ }
  close() { /* no-op */ }
}

class Input {
  constructor(name, _virtual) { this.name = name; }
  on(_event, _cb) { /* no-op */ }
  close() { /* no-op */ }
}

module.exports = { Output, Input };
