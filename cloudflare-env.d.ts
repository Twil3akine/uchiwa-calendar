declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    CREATE_LIMIT?: RateLimit;
    WRITE_LIMIT?: RateLimit;
    READ_LIMIT?: RateLimit;
    BUCKET?: R2Bucket;
  }
}
