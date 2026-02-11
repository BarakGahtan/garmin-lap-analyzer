// Minimal FIT file parser for Garmin activity data
// Focuses on lap (msg 19) and record (msg 20) messages

const FIT_MSG_NAMES = {
  0: 'file_id', 18: 'session', 19: 'lap', 20: 'record',
  21: 'event', 23: 'device_info', 34: 'activity',
};

const FIT_FIELDS = {
  19: { // lap
    2:   { name: 'start_time' },
    7:   { name: 'total_elapsed_time', scale: 1000 },
    8:   { name: 'total_timer_time', scale: 1000 },
    9:   { name: 'total_distance', scale: 100 },
    13:  { name: 'avg_speed', scale: 1000 },
    14:  { name: 'max_speed', scale: 1000 },
    15:  { name: 'avg_heart_rate' },
    16:  { name: 'max_heart_rate' },
    110: { name: 'enhanced_avg_speed', scale: 1000 },
    111: { name: 'enhanced_max_speed', scale: 1000 },
    253: { name: 'timestamp' },
  },
  20: { // record
    0:   { name: 'position_lat' },
    1:   { name: 'position_long' },
    2:   { name: 'altitude', scale: 5, offset: 500 },
    3:   { name: 'heart_rate' },
    4:   { name: 'cadence' },
    5:   { name: 'distance', scale: 100 },
    6:   { name: 'speed', scale: 1000 },
    73:  { name: 'enhanced_speed', scale: 1000 },
    78:  { name: 'enhanced_altitude', scale: 5, offset: 500 },
    253: { name: 'timestamp' },
  },
};

const BASE_TYPES = {
  0x00: { size: 1, read: 'getUint8',   invalid: 0xFF },       // enum
  0x01: { size: 1, read: 'getInt8',    invalid: 0x7F },       // sint8
  0x02: { size: 1, read: 'getUint8',   invalid: 0xFF },       // uint8
  0x83: { size: 2, read: 'getInt16',   invalid: 0x7FFF },     // sint16
  0x84: { size: 2, read: 'getUint16',  invalid: 0xFFFF },     // uint16
  0x85: { size: 4, read: 'getInt32',   invalid: 0x7FFFFFFF }, // sint32
  0x86: { size: 4, read: 'getUint32',  invalid: 0xFFFFFFFF }, // uint32
  0x07: { size: 1, read: null,         invalid: 0 },          // string
  0x88: { size: 4, read: 'getFloat32', invalid: null },       // float32
  0x89: { size: 8, read: 'getFloat64', invalid: null },       // float64
  0x0A: { size: 1, read: 'getUint8',   invalid: 0 },         // uint8z
  0x8B: { size: 2, read: 'getUint16',  invalid: 0 },         // uint16z
  0x8C: { size: 4, read: 'getUint32',  invalid: 0 },         // uint32z
  0x0D: { size: 1, read: null,         invalid: null },       // byte array
};

class FitParser {
  constructor(data) {
    if (data instanceof Uint8Array) {
      this.bytes = data;
      this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    } else {
      this.bytes = new Uint8Array(data);
      this.view = new DataView(data);
    }
    this.offset = 0;
    this.definitions = {};
    this.messages = {};
    this.lastTimestamp = 0;
  }

  parse() {
    this._parseHeader();
    const dataEnd = this.dataOffset + this.dataSize;
    while (this.offset < dataEnd) {
      try {
        this._parseRecord();
      } catch (e) {
        // Skip corrupted records at end of file
        break;
      }
    }
    return this.messages;
  }

  _parseHeader() {
    const headerSize = this.view.getUint8(0);
    this.dataSize = this.view.getUint32(4, true);
    const sig = String.fromCharCode(
      this.bytes[8], this.bytes[9], this.bytes[10], this.bytes[11]
    );
    if (sig !== '.FIT') throw new Error('Not a valid FIT file');
    this.offset = headerSize;
    this.dataOffset = headerSize;
  }

  _parseRecord() {
    const header = this.view.getUint8(this.offset++);

    if (header & 0x80) {
      // Compressed timestamp
      const localType = (header >> 5) & 0x03;
      const timeOffset = header & 0x1F;
      const prev = this.lastTimestamp;
      let ts = (prev & 0xFFFFFFE0) + timeOffset;
      if (timeOffset < (prev & 0x1F)) ts += 0x20;
      this.lastTimestamp = ts;
      this._parseDataMessage(localType, ts);
    } else if (header & 0x40) {
      // Definition message
      const localType = header & 0x0F;
      const hasDev = !!(header & 0x20);
      this._parseDefinition(localType, hasDev);
    } else {
      // Data message
      const localType = header & 0x0F;
      this._parseDataMessage(localType);
    }
  }

  _parseDefinition(localType, hasDev) {
    this.offset++; // reserved
    const arch = this.view.getUint8(this.offset++);
    const littleEndian = arch === 0;
    const globalMsgNum = this.view.getUint16(this.offset, littleEndian);
    this.offset += 2;
    const numFields = this.view.getUint8(this.offset++);

    const fields = [];
    for (let i = 0; i < numFields; i++) {
      fields.push({
        num: this.view.getUint8(this.offset++),
        size: this.view.getUint8(this.offset++),
        baseType: this.view.getUint8(this.offset++),
      });
    }

    let devFields = [];
    if (hasDev) {
      const numDev = this.view.getUint8(this.offset++);
      for (let i = 0; i < numDev; i++) {
        devFields.push({
          num: this.view.getUint8(this.offset++),
          size: this.view.getUint8(this.offset++),
          devIdx: this.view.getUint8(this.offset++),
        });
      }
    }

    this.definitions[localType] = { globalMsgNum, littleEndian, fields, devFields };
  }

  _parseDataMessage(localType, compressedTs) {
    const def = this.definitions[localType];
    if (!def) {
      throw new Error(`No definition for local type ${localType}`);
    }

    const profileFields = FIT_FIELDS[def.globalMsgNum] || {};
    const msg = {};

    for (const field of def.fields) {
      const value = this._readField(field, def.littleEndian);
      const profile = profileFields[field.num];
      if (profile && value !== null) {
        let v = value;
        if (profile.scale) v = v / profile.scale;
        if (profile.offset) v = v - profile.offset;
        msg[profile.name] = v;
      }
    }

    // Skip developer fields
    for (const df of def.devFields) {
      this.offset += df.size;
    }

    // Inject compressed timestamp if no explicit timestamp
    if (compressedTs !== undefined && msg.timestamp == null) {
      msg.timestamp = compressedTs;
    }

    // Track timestamp
    if (msg.timestamp != null) {
      this.lastTimestamp = msg.timestamp;
    }

    // Store message by type name
    const typeName = FIT_MSG_NAMES[def.globalMsgNum];
    if (typeName) {
      if (!this.messages[typeName]) this.messages[typeName] = [];
      this.messages[typeName].push(msg);
    }
  }

  _readField(field, littleEndian) {
    const { size, baseType } = field;
    const typeInfo = BASE_TYPES[baseType] || BASE_TYPES[baseType & 0x1F];

    if (!typeInfo || !typeInfo.read) {
      // String, byte array, or unknown type - skip
      this.offset += size;
      return null;
    }

    // Array fields (size > base type size) - skip
    if (size !== typeInfo.size) {
      this.offset += size;
      return null;
    }

    const value = this.view[typeInfo.read](this.offset, littleEndian);
    this.offset += size;

    // Check invalid sentinel
    if (typeInfo.invalid !== null && value === typeInfo.invalid) return null;

    return value;
  }
}
