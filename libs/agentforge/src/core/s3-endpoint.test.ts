import { describe, expect, it } from 'vitest';
import { S3_ENDPOINT_VARIABLE, s3ClientConfiguration } from './s3-endpoint.ts';

describe('s3ClientConfiguration', () => {
  it("is S3's own when no endpoint is named", () => {
    expect(s3ClientConfiguration({})).toEqual({});
    expect(s3ClientConfiguration({ [S3_ENDPOINT_VARIABLE]: '' })).toEqual({});
  });

  it('addresses a named endpoint path-style', () => {
    expect(
      s3ClientConfiguration({ [S3_ENDPOINT_VARIABLE]: 'http://s3:8333' }),
    ).toEqual({ endpoint: 'http://s3:8333', forcePathStyle: true });
  });
});
