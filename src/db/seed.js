require('dotenv').config();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { getDb } = require('./database');

const COMPANY_ID = 'a0000000-0000-0000-0000-000000000001';

async function seed() {
  const pool = getDb();

  console.log('Seeding VendVault database...');

  // Company
  await pool.query(
    `INSERT INTO vend_companies (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [COMPANY_ID, 'Brennan & Co', 'brennanco']
  );

  // Admin user
  const passwordHash = await bcrypt.hash('vendvault2026', 10);
  const userId = uuidv4();
  await pool.query(
    `INSERT INTO vend_users (id, company_id, email, password_hash, name, role) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [userId, COMPANY_ID, 'admin@brennanco.com', passwordHash, 'Admin', 'owner']
  );

  // Location: Copper Basin
  const locationId = 'loc-copper-basin-0001';
  await pool.query(
    `INSERT INTO vending_locations (id, company_id, name, address, city, state, zip) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [locationId, COMPANY_ID, 'Copper Basin', '', 'Queen Creek', 'AZ', '85144']
  );

  // Machine 1: Snack
  const machine1Id = 'mach-vk100125641-0001';
  await pool.query(
    `INSERT INTO vending_machines (id, company_id, location_id, name, machine_type, cantaloupe_device_id, layout_rows, layout_cols, commission_pct, monthly_fixed_cost) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
    [machine1Id, COMPANY_ID, locationId, 'Snack Machine', 'snack', 'VK100125641', 5, 6, 0, 0]
  );

  // Machine 2: Drinks
  const machine2Id = 'mach-vk100125642-0001';
  await pool.query(
    `INSERT INTO vending_machines (id, company_id, location_id, name, machine_type, cantaloupe_device_id, layout_rows, layout_cols, commission_pct, monthly_fixed_cost) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
    [machine2Id, COMPANY_ID, locationId, 'Drinks Machine', 'drinks', 'VK100125642', 5, 6, 0, 0]
  );

  // Products
  const products = [
    { id: 'prod-0001', name: 'Lays Classic', category: 'snack', purchase_price: 0.65, sell_price: 1.25, unit_size: '1oz', sku: 'LAY-CLS-1OZ' },
    { id: 'prod-0002', name: 'Doritos Nacho', category: 'snack', purchase_price: 0.65, sell_price: 1.25, unit_size: '1oz', sku: 'DOR-NCH-1OZ' },
    { id: 'prod-0003', name: 'Cheetos Crunchy', category: 'snack', purchase_price: 0.65, sell_price: 1.25, unit_size: '1oz', sku: 'CHE-CRN-1OZ' },
    { id: 'prod-0004', name: 'Snickers', category: 'candy', purchase_price: 0.70, sell_price: 1.50, unit_size: '1.86oz', sku: 'SNK-REG' },
    { id: 'prod-0005', name: 'Nature Valley Oats', category: 'healthy', purchase_price: 0.60, sell_price: 1.50, unit_size: '1.5oz', sku: 'NV-OATS' },
    { id: 'prod-0006', name: 'Coca-Cola', category: 'drink', purchase_price: 0.55, sell_price: 1.50, unit_size: '12oz', sku: 'COKE-12' },
    { id: 'prod-0007', name: 'Diet Coke', category: 'drink', purchase_price: 0.55, sell_price: 1.50, unit_size: '12oz', sku: 'DCOKE-12' },
    { id: 'prod-0008', name: 'Sprite', category: 'drink', purchase_price: 0.55, sell_price: 1.50, unit_size: '12oz', sku: 'SPRT-12' },
    { id: 'prod-0009', name: 'Water', category: 'drink', purchase_price: 0.25, sell_price: 1.50, unit_size: '16.9oz', sku: 'H2O-16' },
    { id: 'prod-0010', name: 'Red Bull', category: 'drink', purchase_price: 1.20, sell_price: 3.00, unit_size: '8.4oz', sku: 'RB-84' },
  ];

  for (const p of products) {
    await pool.query(
      `INSERT INTO vending_products (id, company_id, name, sku, category, purchase_price, sell_price, unit_size) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [p.id, COMPANY_ID, p.name, p.sku, p.category, p.purchase_price, p.sell_price, p.unit_size]
    );
    await pool.query(
      `INSERT INTO inventory_warehouse (id, company_id, product_id, quantity, reorder_threshold) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [uuidv4(), COMPANY_ID, p.id, 24, 12]
    );
  }

  // Slots for Snack Machine
  const snackSlots = [
    { code: '0C06', row: 0, col: 0, product_id: 'prod-0001', capacity: 10, qty: 7 },
    { code: '0D05', row: 0, col: 1, product_id: 'prod-0004', capacity: 10, qty: 5 },
    { code: '0E00', row: 0, col: 2, product_id: 'prod-0002', capacity: 10, qty: 8 },
    { code: '1103', row: 1, col: 0, product_id: 'prod-0003', capacity: 12, qty: 4 },
    { code: '1104', row: 1, col: 1, product_id: 'prod-0005', capacity: 10, qty: 9 },
    { code: '1105', row: 2, col: 0, product_id: null,         capacity: 10, qty: 0 },
  ];

  for (const s of snackSlots) {
    const slotId = `slot-m1-${s.code}`;
    await pool.query(
      `INSERT INTO machine_slots (id, company_id, machine_id, slot_code, row_index, col_index, capacity, current_quantity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [slotId, COMPANY_ID, machine1Id, s.code, s.row, s.col, s.capacity, s.qty]
    );
    if (s.product_id) {
      await pool.query(
        `INSERT INTO slot_product_assignments (id, company_id, slot_id, product_id, is_current) VALUES ($1, $2, $3, $4, true) ON CONFLICT DO NOTHING`,
        [uuidv4(), COMPANY_ID, slotId, s.product_id]
      );
    }
  }

  // Slots for Drinks Machine
  const drinkSlots = [
    { code: '0001', row: 0, col: 0, product_id: 'prod-0006', capacity: 12, qty: 8 },
    { code: '0004', row: 0, col: 1, product_id: 'prod-0010', capacity: 10, qty: 3 },
    { code: '0007', row: 0, col: 2, product_id: 'prod-0007', capacity: 12, qty: 10 },
    { code: '0008', row: 1, col: 0, product_id: 'prod-0008', capacity: 12, qty: 6 },
    { code: '0009', row: 1, col: 1, product_id: 'prod-0009', capacity: 12, qty: 11 },
    { code: '0010', row: 2, col: 0, product_id: null,         capacity: 12, qty: 0 },
  ];

  for (const s of drinkSlots) {
    const slotId = `slot-m2-${s.code}`;
    await pool.query(
      `INSERT INTO machine_slots (id, company_id, machine_id, slot_code, row_index, col_index, capacity, current_quantity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
      [slotId, COMPANY_ID, machine2Id, s.code, s.row, s.col, s.capacity, s.qty]
    );
    if (s.product_id) {
      await pool.query(
        `INSERT INTO slot_product_assignments (id, company_id, slot_id, product_id, is_current) VALUES ($1, $2, $3, $4, true) ON CONFLICT DO NOTHING`,
        [uuidv4(), COMPANY_ID, slotId, s.product_id]
      );
    }
  }

  // Fixed costs
  await pool.query(
    `INSERT INTO vending_fixed_costs (id, company_id, location_id, cost_type, description, amount, frequency, effective_from) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
    ['cost-0001', COMPANY_ID, locationId, 'rent', 'Copper Basin location fee', 50.00, 'monthly', '2026-01-01']
  );

  await pool.end();
  console.log('Seed complete!');
  console.log('Login: admin@brennanco.com / vendvault2026');
}

seed().catch(console.error);
