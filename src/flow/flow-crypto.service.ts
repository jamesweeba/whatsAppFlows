import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';

export interface DecryptedFlowPayload {
  version: string;
  action: 'INIT' | 'data_exchange' | 'BACK' | 'ping';
  screen?: string;
  data?: Record<string, any>;
  flow_token?: string;
}

export interface EncryptedFlowRequest {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
}

@Injectable()
export class FlowCryptoService {
  private readonly logger = new Logger(FlowCryptoService.name);

  /**
   * Decrypts incoming request from Meta WhatsApp Flows.
   */
  decryptRequest(
    body: EncryptedFlowRequest,
    privateKeyPem: string,
    passphrase?: string,
  ): { decryptedPayload: DecryptedFlowPayload; aesKey: Buffer; iv: Buffer } {
    try {
      const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;

      const encryptedAesKeyBuffer = Buffer.from(encrypted_aes_key, 'base64');
      const ivBuffer = Buffer.from(initial_vector, 'base64');
      const encryptedFlowDataBuffer = Buffer.from(encrypted_flow_data, 'base64');

      let formattedPrivateKey = (privateKeyPem || '').trim();
      if (formattedPrivateKey.includes('\\n')) {
        formattedPrivateKey = formattedPrivateKey.replace(/\\n/g, '\n');
      }

      if (!formattedPrivateKey || formattedPrivateKey.includes('...')) {
        throw new Error(
          'META_FLOW_PRIVATE_KEY in .env is invalid or still a placeholder. Please set a valid RSA-2048 Private Key.',
        );
      }

      // 1. Decrypt AES Key using RSA Private Key (OAEP SHA-256)
      const aesKeyBuffer = crypto.privateDecrypt(
        {
          key: formattedPrivateKey,
          passphrase: passphrase || undefined,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        encryptedAesKeyBuffer,
      );

      // 2. Extract Auth Tag (last 16 bytes) and Cipher Text
      const tagLength = 16;
      const cipherText = encryptedFlowDataBuffer.subarray(0, encryptedFlowDataBuffer.length - tagLength);
      const authTag = encryptedFlowDataBuffer.subarray(encryptedFlowDataBuffer.length - tagLength);

      // 3. Decrypt payload using AES-128-GCM
      const decipher = crypto.createDecipheriv('aes-128-gcm', aesKeyBuffer, ivBuffer);
      decipher.setAuthTag(authTag);

      const decryptedText = Buffer.concat([
        decipher.update(cipherText),
        decipher.final(),
      ]).toString('utf8');

      const decryptedPayload: DecryptedFlowPayload = JSON.parse(decryptedText);

      return {
        decryptedPayload,
        aesKey: aesKeyBuffer,
        iv: ivBuffer,
      };
    } catch (error: any) {
      this.logger.error(`Flow payload decryption failed: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to decrypt WhatsApp Flow payload: ${error.message}`);
    }
  }

  /**
   * Encrypts outgoing response payload back to Meta WhatsApp Flows.
   * Uses bitwise NOT on the initial vector (IV) per Meta specification.
   */
  encryptResponse(
    responsePayload: Record<string, any>,
    aesKey: Buffer,
    iv: Buffer,
  ): string {
    try {
      // 1. Invert IV bits as required by Meta Flows response protocol
      const flippedIv = Buffer.from(iv);
      for (let i = 0; i < flippedIv.length; i++) {
        flippedIv[i] = ~flippedIv[i];
      }

      // 2. Encrypt response payload using AES-128-GCM
      const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
      const payloadString = JSON.stringify(responsePayload);

      const cipherText = Buffer.concat([
        cipher.update(payloadString, 'utf8'),
        cipher.final(),
      ]);

      const authTag = cipher.getAuthTag();

      // 3. Concatenate cipherText + authTag and encode to base64
      const encryptedResponseBuffer = Buffer.concat([cipherText, authTag]);
      return encryptedResponseBuffer.toString('base64');
    } catch (error: any) {
      this.logger.error(`Flow payload encryption failed: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to encrypt WhatsApp Flow response: ${error.message}`);
    }
  }
}
