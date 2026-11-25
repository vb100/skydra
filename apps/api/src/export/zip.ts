import { crc32 } from 'node:zlib';

/**
 * A ZIP archive of the given files, stored without compression (PDFs and photos are already
 * compressed). Names are UTF-8 (general-purpose flag bit 11), so Lithuanian letters survive.
 * Files and the archive must stay below 4 GiB (no ZIP64); case exports are far smaller.
 */
export type ZipEntry = { name: string; data: Buffer; modified?: Date };

const LIMIT = 0xffff_ffff;

/** MS-DOS date and time, as ZIP stores them (local time, two-second steps, from 1980). */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(d.getFullYear(), 1980);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const names = new Set<string>();

  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`duplicate entry ${entry.name}`);
    names.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    const { time, date } = dosDateTime(entry.modified ?? new Date());
    const crc = crc32(entry.data);
    const size = entry.data.length;
    if (size >= LIMIT || offset >= LIMIT)
      throw new Error('archive too large for ZIP without ZIP64');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by: 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal and external attributes: none
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + size;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
