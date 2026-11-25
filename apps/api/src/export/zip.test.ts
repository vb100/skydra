import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zip } from './zip';

/** Reads the central directory back: names, sizes, CRCs and each entry's data. */
function entries(archive: Buffer) {
  const end = archive.length - 22;
  expect(archive.readUInt32LE(end)).toBe(0x06054b50);
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const found: { name: string; crc: number; data: Buffer; flags: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(archive.readUInt32LE(at)).toBe(0x02014b50);
    const flags = archive.readUInt16LE(at + 8);
    const crc = archive.readUInt32LE(at + 16);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const offset = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const localName = archive.readUInt16LE(offset + 26);
    const data = archive.subarray(offset + 30 + localName, offset + 30 + localName + size);
    found.push({ name, crc, data, flags });
    at += 46 + nameLength;
  }
  return found;
}

describe('zip', () => {
  const files = [
    { name: 'Case_Report.pdf', data: Buffer.from('%PDF-1.4 ataskaita') },
    {
      name: 'Attachments/Identity/Asmens tapatybės kortelė.jpg',
      data: Buffer.from([0xff, 0xd8, 0xff, 1, 2]),
    },
    { name: 'Attachments/Other/tuščias.txt', data: Buffer.alloc(0) },
  ];

  it('stores every file with its name (UTF-8), size and CRC-32', () => {
    const read = entries(zip(files));
    expect(read.map((e) => e.name)).toEqual(files.map((f) => f.name));
    for (const [i, e] of read.entries()) {
      expect(e.data.equals(files[i]!.data)).toBe(true);
      expect(e.crc).toBe(crc32(files[i]!.data));
      expect(e.flags & 0x0800).toBe(0x0800);
    }
  });

  it('refuses the same name twice', () => {
    expect(() => zip([files[0]!, files[0]!])).toThrow(/duplicate/);
  });

  it('is read by standard tools, names included', () => {
    const has = (tool: string, args: string[]) => {
      try {
        execFileSync(tool, args, { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    };
    const dir = mkdtempSync(join(tmpdir(), 'skydra-zip-'));
    const path = join(dir, 'case.zip');
    writeFileSync(path, zip(files));
    if (has('unzip', ['-v']))
      expect(execFileSync('unzip', ['-tq', path]).toString()).toMatch(/No errors/);
    // Python's zipfile honours the UTF-8 flag, as Windows Explorer and macOS Archive Utility do
    // (the old Info-ZIP unzip on macOS does not).
    if (has('python3', ['--version'])) {
      const script =
        'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); ' +
        'print(json.dumps([z.testzip(), z.namelist(), z.read(sys.argv[2]).hex()]))';
      const [bad, names, hex] = JSON.parse(
        execFileSync('python3', ['-I', '-c', script, path, files[1]!.name]).toString(),
      ) as [string | null, string[], string];
      expect(bad).toBeNull();
      expect(names).toEqual(files.map((f) => f.name));
      expect(hex).toBe(files[1]!.data.toString('hex'));
    }
  });
});
