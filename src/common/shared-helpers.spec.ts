import { BadRequestException } from '@nestjs/common';
import { NumberStatus, TenantStatus } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { AddNumberDto } from '../admin/dto/add-number.dto.js';
import { CreateTenantDto } from '../tenant/dto/create-tenant.dto.js';
import { UpdateTenantDto } from '../tenant/dto/update-tenant.dto.js';
import { isLive } from '../tenant/tenant.service.js';
import { MEASURE_CODES, RESERVED_MEASURE_CODES } from './measure-codes.js';
import { parseEnumList } from './query.util.js';

/** Every message, including nested ones (e.g. inside deliveryAreas[0]). */
const messages = (errors: ValidationError[]): string[] =>
  errors.flatMap((e) => [...Object.values(e.constraints ?? {}), ...messages(e.children ?? [])]);

/** Validate the way the global ValidationPipe does (whitelist + forbidNonWhitelisted). */
const errorsFor = (cls: any, body: Record<string, unknown>) =>
  messages(validateSync(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true }));

describe('parseEnumList', () => {
  it('parses a comma list case-insensitively and ignores an absent parameter', () => {
    expect(parseEnumList('stocked, UNDER_REVIEW', TenantStatus)).toEqual(['STOCKED', 'UNDER_REVIEW']);
    expect(parseEnumList(undefined, NumberStatus)).toBeUndefined();
    expect(parseEnumList('  ', NumberStatus)).toBeUndefined();
  });

  it('rejects unknown values, listing the valid ones', () => {
    expect(() => parseEnumList('FREE,taken', NumberStatus)).toThrow(BadRequestException);
    expect(() => parseEnumList('constructor', NumberStatus)).toThrow('Unknown status CONSTRUCTOR. Use: FREE, ASSIGNED, COOLING.');
  });
});

describe('@IsPhone', () => {
  it('accepts the usual Ghana formats and names the field in the error', () => {
    expect(errorsFor(AddNumberDto, { phoneNumberId: '123456789', displayNumber: '+233 24 411 1222' })).toEqual([]);
    expect(errorsFor(AddNumberDto, { phoneNumberId: '123456789', displayNumber: 'call me' })).toEqual([
      'displayNumber must be a phone number, e.g. 0244111222 or +233244111222',
    ]);
  });
});

describe('UpdateTenantDto (derived from CreateTenantDto)', () => {
  const create = { name: 'Ama Groceries', ownerFullName: 'Ama Mensah', ownerPhone: '0244111222' };

  it('makes every create field optional but keeps its validation', () => {
    expect(errorsFor(UpdateTenantDto, {})).toEqual([]);
    expect(errorsFor(UpdateTenantDto, { deliveryFee: 8, market: 'Kejetia' })).toEqual([]);
    expect(errorsFor(UpdateTenantDto, { momoNumber: 'not a phone' })).toEqual([
      'momoNumber must be a phone number, e.g. 0244111222 or +233244111222',
    ]);
    expect(errorsFor(UpdateTenantDto, { deliveryFee: -1 })).toHaveLength(1);
    expect(errorsFor(UpdateTenantDto, { deliveryAreas: [{ id: 'Bad Id', title: 'KNUST' }] })).toEqual([
      'Area id must be lowercase letters, digits or underscores (e.g. "knust").',
    ]);
  });

  it('cannot change the slug, but can set whatsappNumber (own-number onboarding)', () => {
    expect(errorsFor(UpdateTenantDto, { slug: 'new-slug' })).toEqual(['property slug should not exist']);
    expect(errorsFor(UpdateTenantDto, { whatsappNumber: '0200000000' })).toEqual([]);
  });

  it('still requires the owner details when creating', () => {
    expect(errorsFor(CreateTenantDto, create)).toEqual([]);
    expect(errorsFor(CreateTenantDto, { name: 'Ama Groceries' }).length).toBeGreaterThan(0);
  });
});

describe('shared rules', () => {
  it('only an ACTIVE shop is live', () => {
    expect(isLive({ status: TenantStatus.ACTIVE })).toBe(true);
    for (const status of Object.values(TenantStatus).filter((s) => s !== TenantStatus.ACTIVE)) {
      expect(isLive({ status })).toBe(false);
    }
  });

  it('reserves the codes the Flow uses for its own buttons', () => {
    expect(RESERVED_MEASURE_CODES).toEqual([MEASURE_CODES.REMOVE, MEASURE_CODES.NONE]);
  });
});
