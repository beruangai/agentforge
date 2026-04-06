import { describe, it, expect } from 'vitest';
import { filterTools, isToolAllowed, parseToolFilter } from './tool-filter.js';
import type { GatewayTool } from './types.js';

const tools: GatewayTool[] = [
  { name: 'vault:read', description: 'Read from vault' },
  { name: 'vault:list', description: 'List vault items' },
  { name: 'vault:write', description: 'Write to vault' },
  { name: 'serpapi:search', description: 'Search the web' },
  { name: 'data:query', description: 'Query data' },
  { name: 'data:fetch', description: 'Fetch data' },
];

describe('filterTools', () => {
  it('returns all tools when pattern is wildcard', () => {
    const result = filterTools(tools, ['*']);
    expect(result).toEqual(tools);
  });

  it('filters by exact match', () => {
    const result = filterTools(tools, ['vault:read']);
    expect(result).toEqual([tools[0]]);
  });

  it('filters by glob wildcard pattern', () => {
    const result = filterTools(tools, ['vault:*']);
    expect(result).toEqual([tools[0], tools[1], tools[2]]);
  });

  it('supports multiple patterns', () => {
    const result = filterTools(tools, ['vault:read', 'serpapi:search']);
    expect(result).toEqual([tools[0], tools[3]]);
  });

  it('supports mixed exact and glob patterns', () => {
    const result = filterTools(tools, ['vault:*', 'serpapi:search']);
    expect(result).toEqual([tools[0], tools[1], tools[2], tools[3]]);
  });

  it('returns empty array when no tools match', () => {
    const result = filterTools(tools, ['nonexistent:*']);
    expect(result).toEqual([]);
  });

  it('handles empty tools array', () => {
    const result = filterTools([], ['vault:*']);
    expect(result).toEqual([]);
  });

  it('handles empty patterns array', () => {
    const result = filterTools(tools, []);
    expect(result).toEqual([]);
  });

  it('glob pattern with multiple server prefixes', () => {
    const result = filterTools(tools, ['data:*', 'vault:*']);
    expect(result).toEqual([tools[0], tools[1], tools[2], tools[4], tools[5]]);
  });
});

describe('isToolAllowed', () => {
  it('returns true for exact match', () => {
    expect(isToolAllowed('vault:read', ['vault:read'])).toBe(true);
  });

  it('returns true for glob match', () => {
    expect(isToolAllowed('vault:read', ['vault:*'])).toBe(true);
  });

  it('returns false when no pattern matches', () => {
    expect(isToolAllowed('vault:read', ['serpapi:*'])).toBe(false);
  });

  it('returns true for wildcard-all', () => {
    expect(isToolAllowed('vault:read', ['*'])).toBe(true);
  });

  it('returns false for empty patterns', () => {
    expect(isToolAllowed('vault:read', [])).toBe(false);
  });

  it('checks multiple patterns', () => {
    expect(isToolAllowed('serpapi:search', ['vault:*', 'serpapi:search'])).toBe(
      true,
    );
  });
});

describe('parseToolFilter', () => {
  it('parses comma-separated tools', () => {
    const headers = new Headers({ 'X-Tools': 'vault:read,vault:list' });
    expect(parseToolFilter(headers)).toEqual(['vault:read', 'vault:list']);
  });

  it('trims whitespace', () => {
    const headers = new Headers({
      'X-Tools': ' vault:read , vault:list ',
    });
    expect(parseToolFilter(headers)).toEqual(['vault:read', 'vault:list']);
  });

  it('returns wildcard when header is absent', () => {
    const headers = new Headers();
    expect(parseToolFilter(headers)).toEqual(['*']);
  });

  it('returns wildcard for empty header value', () => {
    const headers = new Headers({ 'X-Tools': '' });
    expect(parseToolFilter(headers)).toEqual(['*']);
  });

  it('handles single tool', () => {
    const headers = new Headers({ 'X-Tools': 'serpapi:search' });
    expect(parseToolFilter(headers)).toEqual(['serpapi:search']);
  });

  it('handles glob patterns in header', () => {
    const headers = new Headers({ 'X-Tools': 'vault:*,data:*' });
    expect(parseToolFilter(headers)).toEqual(['vault:*', 'data:*']);
  });

  it('filters out empty entries from trailing comma', () => {
    const headers = new Headers({ 'X-Tools': 'vault:read,' });
    expect(parseToolFilter(headers)).toEqual(['vault:read']);
  });
});
