import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const products = [
  // Vegetables
  { name: 'Tomatoes (1 basket)',               image: '🍅', price: 85.00,  inStock: true },
  { name: 'Onions (1 bag)',                    image: '🧅', price: 60.00,  inStock: true },
  { name: 'Scotch Bonnet Pepper (1 cup)',      image: '🌶️', price: 10.00, inStock: true },
  { name: 'Garden Eggs (1 dozen)',             image: '🍆', price: 8.00,   inStock: true },
  { name: 'Okra (500g)',                       image: '🥦', price: 12.00,  inStock: true },
  { name: 'Kontomire (Cocoyam Leaves, 1 bunch)', image: '🌿', price: 5.00, inStock: true },
  { name: 'Spring Onion (1 bunch)',            image: '🧄', price: 4.00,   inStock: true },
  { name: 'Cabbage (1 head)',                  image: '🥬', price: 15.00,  inStock: true },
  { name: 'Carrots (500g)',                    image: '🥕', price: 10.00,  inStock: true },

  // Fruits
  { name: 'Plantain (1 bunch)',                image: '🍌', price: 25.00,  inStock: true },
  { name: 'Banana (1 bunch)',                  image: '🍌', price: 15.00,  inStock: true },
  { name: 'Pineapple (each)',                  image: '🍍', price: 10.00,  inStock: true },
  { name: 'Watermelon (each)',                 image: '🍉', price: 30.00,  inStock: false },

  // Grains & Staples
  { name: 'Gari (1 bag 50kg)',                 image: '🌾', price: 220.00, inStock: true },
  { name: 'Rice (25kg bag)',                   image: '🍚', price: 320.00, inStock: true },
  { name: 'Maize (1 tin)',                     image: '🌽', price: 18.00,  inStock: true },
  { name: 'Groundnuts (1 tin)',                image: '🥜', price: 25.00,  inStock: true },

  // Proteins
  { name: 'Fresh Tilapia (1kg)',               image: '🐟', price: 55.00,  inStock: true },
  { name: 'Smoked Herrings (5 pieces)',        image: '🐠', price: 20.00,  inStock: true },
  { name: 'Chicken (whole, 1.5kg)',            image: '🍗', price: 95.00,  inStock: false },
];

async function main() {
  const targetTenantId = process.env.TENANT_ID;

  let tenant = targetTenantId
    ? await prisma.tenant.findUnique({ where: { id: targetTenantId } })
    : null;

  if (!tenant) {
    tenant = await prisma.tenant.findFirst();
  }

  if (!tenant) {
    throw new Error('No tenant found in database. Please register a tenant before seeding products.');
  }

  console.log(`Seeding ${products.length} products for tenant "${tenant.name}" (${tenant.id})...`);

  // Clear existing products for this tenant first
  const deleted = await prisma.product.deleteMany({ where: { tenantId: tenant.id } });
  console.log(`Cleared ${deleted.count} existing products.`);

  const created = await prisma.product.createMany({
    data: products.map((p) => ({
      ...p,
      tenantId: tenant.id,
    })),
  });

  console.log(`✅ Successfully seeded ${created.count} products into the "Product" table.`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

