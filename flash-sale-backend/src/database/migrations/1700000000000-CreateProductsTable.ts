import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProductsTable1700000000000 implements MigrationInterface {
  name = 'CreateProductsTable1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "products" (
        "productId" varchar(50) NOT NULL,
        "name" varchar(255) NOT NULL,
        "description" text,
        "price" decimal(10,2) NOT NULL,
        "availableStock" int NOT NULL,
        "remainingStock" int NOT NULL,
        "isFlashSaleActive" boolean NOT NULL,
        "version" int NOT NULL DEFAULT 1,
        CONSTRAINT "PK_products" PRIMARY KEY ("productId")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "products"`);
  }
}