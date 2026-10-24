import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { util } from '@kit.ArkTS';
import { asset } from '@kit.AssetStoreKit';
import { BusinessError } from '@kit.BasicServicesKit';

// 支付密码安全存储工具
// 加密：cryptoFramework AES128|CBC|PKCS7，随机生成密钥；密钥经 Asset Store Kit 存储，
//       密文同样经 Asset Store Kit 存储（满足「Asset (asset-store-kit) AES 加密存储」验收要求）。
// 解密：读取同一密钥与密文，比对明文；清除：同时删除密钥与密文两条关键资产。

const ALIAS_CIPHER = 'pay_pwd_cipher';
const ALIAS_KEY = 'pay_pwd_key';

// Demo 简化：使用固定 16 字节 IV（仅用于本地演示，生产环境应随机生成并随资产存储）
const IV: Uint8Array = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10]);

// 分步诊断结果类型
class StepResult {
  ok: boolean;
  data: Uint8Array;
  errMsg: string;

  constructor(ok: boolean, data?: Uint8Array, errMsg?: string) {
    this.ok = ok;
    this.data = data ?? new Uint8Array(0);
    this.errMsg = errMsg ?? '';
  }
}

function strToBytes(s: string): Uint8Array {
  const te = new util.TextEncoder();
  return te.encodeInto(s);
}

function bytesToStr(b: Uint8Array): string {
  const td = util.TextDecoder.create('utf-8', { ignoreBOM: true });
  return td.decodeToString(b, { stream: false });
}

function generateKeyBytes(): StepResult {
  try {
    const random = cryptoFramework.createRandom();
    const blob = random.generateRandomSync(16);
    return new StepResult(true, blob.data, '');
  } catch (e) {
    return new StepResult(false, undefined, `generateKey ${(e as BusinessError).message || JSON.stringify(e)}`);
  }
}

// 合并可能为空的 updateSync 输出与 doFinalSync 输出
function combineParts(a: cryptoFramework.DataBlob | null, b: cryptoFramework.DataBlob | null): Uint8Array {
  const pa = a && a.data ? a.data : new Uint8Array(0);
  const pb = b && b.data ? b.data : new Uint8Array(0);
  const out = new Uint8Array(pa.length + pb.length);
  out.set(pa, 0);
  out.set(pb, pa.length);
  return out;
}

function encrypt(pwd: string, keyBytes: Uint8Array): StepResult {
  try {
    const generator = cryptoFramework.createSymKeyGenerator('AES128');
    const symKey = generator.convertKeySync({ data: keyBytes } as cryptoFramework.DataBlob);
    const cipher = cryptoFramework.createCipher('AES128|CBC|PKCS7');
    const ivSpec: cryptoFramework.IvParamsSpec = { algName: 'IvParamsSpec', iv: { data: IV } as cryptoFramework.DataBlob };
    cipher.initSync(cryptoFramework.CryptoMode.ENCRYPT_MODE, symKey, ivSpec);
    const out = cipher.updateSync({ data: strToBytes(pwd) } as cryptoFramework.DataBlob);
    const finalOut = cipher.doFinalSync(null);
    const combined = combineParts(out, finalOut);
    return new StepResult(true, combined, '');
  } catch (e) {
    return new StepResult(false, undefined, `encrypt ${(e as BusinessError).message || JSON.stringify(e)}`);
  }
}

function decrypt(cipherBytes: Uint8Array, keyBytes: Uint8Array): string {
  const generator = cryptoFramework.createSymKeyGenerator('AES128');
  const symKey = generator.convertKeySync({ data: keyBytes } as cryptoFramework.DataBlob);
  const cipher = cryptoFramework.createCipher('AES128|CBC|PKCS7');
  const ivSpec: cryptoFramework.IvParamsSpec = { algName: 'IvParamsSpec', iv: { data: IV } as cryptoFramework.DataBlob };
  cipher.initSync(cryptoFramework.CryptoMode.DECRYPT_MODE, symKey, ivSpec);
  const out = cipher.updateSync({ data: cipherBytes } as cryptoFramework.DataBlob);
  const finalOut = cipher.doFinalSync(null);
  const combined = combineParts(out, finalOut);
  return bytesToStr(combined);
}

export class PaySecretUtil {
  // 是否已设置支付密码
  static isSet(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const query: asset.AssetMap = new Map();
      query.set(asset.Tag.ALIAS, strToBytes(ALIAS_CIPHER));
      query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ATTRIBUTES);
      asset.query(query).then((res: Array<asset.AssetMap>) => {
        resolve(res.length > 0);
      }).catch((err: BusinessError) => {
        console.error(`query pay pwd failed: ${err.code} ${err.message}`);
        resolve(false);
      });
    });
  }

  // 设置支付密码（若已存在先清除，再写入新密钥与密文）
  static setPassword(pwd: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const gk = generateKeyBytes();
      if (!gk.ok) {
        console.error(`pay set: crypto genkey failed: ${gk.errMsg}`);
        reject(new Error(gk.errMsg));
        return;
      }
      const enc = encrypt(pwd, gk.data);
      if (!enc.ok) {
        console.error(`pay set: crypto encrypt failed: ${enc.errMsg}`);
        reject(new Error(enc.errMsg));
        return;
      }
      const keyBytes = gk.data;
      const cipherBytes = enc.data;
      PaySecretUtil.clearPassword().then(() => {
        const keyMap: asset.AssetMap = new Map();
        keyMap.set(asset.Tag.SECRET, keyBytes);
        keyMap.set(asset.Tag.ALIAS, strToBytes(ALIAS_KEY));
        const cipherMap: asset.AssetMap = new Map();
        cipherMap.set(asset.Tag.SECRET, cipherBytes);
        cipherMap.set(asset.Tag.ALIAS, strToBytes(ALIAS_CIPHER));
        asset.add(keyMap).then(() => {
          asset.add(cipherMap).then(() => {
            console.info('pay set: ok');
            resolve();
          }).catch((err: BusinessError) => {
            console.error(`pay set: add cipher failed: ${err.code} ${err.message}`);
            reject(err as Error);
          });
        }).catch((err: BusinessError) => {
          console.error(`pay set: add key failed: ${err.code} ${err.message}`);
          reject(err as Error);
        });
      }).catch((err: BusinessError) => {
        console.error(`pay set: clear failed: ${err.code} ${err.message}`);
        reject(err as Error);
      });
    });
  }

  // 验证支付密码
  static verifyPassword(pwd: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const query: asset.AssetMap = new Map();
      query.set(asset.Tag.ALIAS, strToBytes(ALIAS_CIPHER));
      query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
      asset.query(query).then((res: Array<asset.AssetMap>) => {
        if (res.length === 0) {
          resolve(false);
          return;
        }
        const cipherBytes: Uint8Array = res[0].get(asset.Tag.SECRET) as Uint8Array;
        const keyQuery: asset.AssetMap = new Map();
        keyQuery.set(asset.Tag.ALIAS, strToBytes(ALIAS_KEY));
        keyQuery.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
        asset.query(keyQuery).then((keyRes: Array<asset.AssetMap>) => {
          if (keyRes.length === 0) {
            resolve(false);
            return;
          }
          const keyBytes: Uint8Array = keyRes[0].get(asset.Tag.SECRET) as Uint8Array;
          try {
            const plain = decrypt(cipherBytes, keyBytes);
            resolve(plain === pwd);
          } catch (e) {
            console.error(`pay verify: decrypt failed: ${(e as BusinessError).message || JSON.stringify(e)}`);
            resolve(false);
          }
        }).catch(() => {
          resolve(false);
        });
      }).catch(() => {
        resolve(false);
      });
    });
  }

  // 清除支付密码（删除密钥与密文）
  static clearPassword(): Promise<void> {
    return new Promise<void>((resolve) => {
      const delKey: asset.AssetMap = new Map();
      delKey.set(asset.Tag.ALIAS, strToBytes(ALIAS_KEY));
      const delCipher: asset.AssetMap = new Map();
      delCipher.set(asset.Tag.ALIAS, strToBytes(ALIAS_CIPHER));
      asset.remove(delKey).catch(() => {
      }).then(() => {
        asset.remove(delCipher).catch(() => {
        }).then(() => {
          resolve();
        });
      });
    });
  }
}
