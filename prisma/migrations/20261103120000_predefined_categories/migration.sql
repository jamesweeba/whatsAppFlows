-- Categories become one platform-wide predefined list instead of being created per tenant.
-- Any tenant-created categories are removed; their products become uncategorised.
UPDATE "Product" SET "categoryId" = NULL;
DELETE FROM "Category";

ALTER TABLE "Category" DROP CONSTRAINT "Category_tenantId_fkey";
DROP INDEX "Category_tenantId_slug_key";
ALTER TABLE "Category" DROP COLUMN "tenantId",
DROP COLUMN "slug";

-- Ids are stable, readable keys used by the vendor API and the WhatsApp Flow.
INSERT INTO "Category" ("id", "title", "description", "sortOrder", "modifiedAt") VALUES
  ('veg_fruits',    'Vegetables & fruits',    'Tomatoes, onions, pepper, plantain', 1,  CURRENT_TIMESTAMP),
  ('rice_oil',      'Rice, oil & provisions', 'Rice, oil, sugar, tinned foods',     2,  CURRENT_TIMESTAMP),
  ('grains_flour',  'Grains, beans & flour',  'Gari, maize, beans, flour',          3,  CURRENT_TIMESTAMP),
  ('meat_frozen',   'Meat & frozen',          'Chicken, beef, sausages',            4,  CURRENT_TIMESTAMP),
  ('fish_seafood',  'Fish & seafood',         'Tilapia, smoked and dried fish',     5,  CURRENT_TIMESTAMP),
  ('dairy_eggs',    'Dairy & eggs',           'Milk, yoghurt, eggs',                6,  CURRENT_TIMESTAMP),
  ('bread_snacks',  'Bread & snacks',         'Bread, biscuits, groundnuts',        7,  CURRENT_TIMESTAMP),
  ('spices',        'Spices & seasoning',     'Shito, seasoning cubes, ginger',     8,  CURRENT_TIMESTAMP),
  ('drinks',        'Drinks & water',         'Water, juice, soft drinks',          9,  CURRENT_TIMESTAMP),
  ('household',     'Household & cleaning',   'Soap, detergent, tissue',            10, CURRENT_TIMESTAMP),
  ('personal_care', 'Personal care',          'Toiletries and cosmetics',           11, CURRENT_TIMESTAMP),
  ('baby',          'Baby products',          'Diapers, baby food',                 12, CURRENT_TIMESTAMP),
  ('other',         'Other',                  'Everything else',                    13, CURRENT_TIMESTAMP);
