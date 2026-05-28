/**
 * Ambient type declarations for optional cloud storage SDKs.
 *
 * These are declared as optional dependencies — users install them when needed.
 * The adapters dynamically import them and throw clear errors if not installed.
 */

declare module "@aws-sdk/client-s3" {
  export class S3Client {
    constructor(options: Record<string, unknown>);
    send(command: unknown): Promise<unknown>;
  }
  export class PutObjectCommand {
    constructor(params: Record<string, unknown>);
  }
  export class GetObjectCommand {
    constructor(params: Record<string, unknown>);
  }
  export class DeleteObjectCommand {
    constructor(params: Record<string, unknown>);
  }
  export class DeleteObjectsCommand {
    constructor(params: Record<string, unknown>);
  }
  export class ListObjectsV2Command {
    constructor(params: Record<string, unknown>);
  }
  export class HeadObjectCommand {
    constructor(params: Record<string, unknown>);
  }
}

declare module "@aws-sdk/s3-request-presigner" {
  export function getSignedUrl(
    client: unknown,
    command: unknown,
    options?: { expiresIn?: number },
  ): Promise<string>;
}

declare module "ali-oss" {
  interface OSSOptions {
    accessKeyId: string;
    accessKeySecret: string;
    bucket: string;
    endpoint: string;
    secure?: boolean;
  }

  class OSS {
    constructor(options: OSSOptions);
    put(key: string, content: Buffer, options?: Record<string, unknown>): Promise<unknown>;
    get(key: string): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    deleteMulti(keys: string[], options?: Record<string, unknown>): Promise<unknown>;
    list(options?: Record<string, unknown>): Promise<unknown>;
    head(key: string): Promise<unknown>;
    signatureUrl(key: string, options?: Record<string, unknown>): string;
  }

  export default OSS;
}

declare module "tos-sdk" {
  interface TOSOptions {
    accessKeyId: string;
    accessKeySecret: string;
    bucket: string;
    region: string;
    endpoint?: string;
  }

  class TOS {
    constructor(options: TOSOptions);
    putObject(params: Record<string, unknown>): Promise<unknown>;
    getObject(params: Record<string, unknown>): Promise<unknown>;
    deleteObject(params: Record<string, unknown>): Promise<unknown>;
    listObjects(params: Record<string, unknown>): Promise<unknown>;
    headObject(params: Record<string, unknown>): Promise<unknown>;
    getPreSignedUrl(params: Record<string, unknown>): string;
  }

  export default TOS;
}
