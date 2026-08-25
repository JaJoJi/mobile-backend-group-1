import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { Product } from '../products/entities/product.entity';

dotenv.config();

export default new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_PRIMARY_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PRIMARY_PORT ?? 5432),
  username: process.env.POSTGRES_USER ?? 'app',
  password: process.env.POSTGRES_PASSWORD ?? 'app123',
  database: process.env.POSTGRES_DB ?? 'flashsale',
  entities: [Product],
  migrations: ['src/database/migrations/*.ts'],
});