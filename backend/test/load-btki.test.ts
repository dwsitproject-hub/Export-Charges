import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/scripts/load-btki';

describe('BTKI CSV parsing', () => {
  it('handles quotes, embedded commas and newlines, CRLF and blank lines', () => {
    const csv = 'code,description\r\n1511.10.00,"Minyak mentah, sawit"\r\n\r\n15119036,"Fraksi ""olein""\nlainnya"\n';
    expect(parseCsv(csv)).toEqual([
      ['code', 'description'],
      ['1511.10.00', 'Minyak mentah, sawit'],
      ['15119036', 'Fraksi "olein"\nlainnya'],
    ]);
  });
});
