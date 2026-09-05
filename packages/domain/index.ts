/**
 * ViralForge Domain Package Index
 * Exports all shared types, schemas, and adapters
 */

export * from './schemas/content-item';
export * from './adapters/omniroute-adapter';
export * from './adapters/meta-publisher';
export * from './validators';
export * from './prompts';

export type {
  NicheId,
  ContentStatus,
  MediaType,
  TriggerSource,
  ContentItem,
  NicheProfile,
  NicheAccount,
  Job,
  AuditLog,
  FoodPayload,
  HealthPayload,
  TechPayload,
  EdTechPayload,
  TravelPayload,
  CartoonPayload,
} from './schemas/content-item';