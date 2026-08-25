import {
  Injectable,
  Logger as NestLogger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Product } from './entities/product.entity';

interface SeedProduct {
  productId: string;
  name: string;
  description: string;
  price: number;
  availableStock: number;
  isFlashSaleActive: boolean;
}

@Injectable()
export class ProductsSeeder implements OnApplicationBootstrap {
  private readonly logger = new NestLogger(ProductsSeeder.name);

  constructor(
    @InjectRepository(Product) private readonly repo: Repository<Product>,
  ) {}

  async onApplicationBootstrap() {
    const existing = await this.repo.count();
    if (existing > 0) {
      this.logger.log(`products table already has ${existing} rows — skipping seed`);
      return;
    }

    const seedPath = path.join(process.cwd(), 'products-seed.json');
    const raw = await fs.readFile(seedPath, 'utf-8');
    const seeds: SeedProduct[] = JSON.parse(raw);

    const products = seeds.map((s) =>
      this.repo.create({
        productId: s.productId,
        name: s.name,
        description: s.description,
        price: s.price,
        availableStock: s.availableStock,
        remainingStock: s.availableStock,
        isFlashSaleActive: s.isFlashSaleActive,
      }),
    );

    await this.repo.save(products);
    this.logger.log(`seeded ${products.length} products from ${seedPath}`);
  }
}