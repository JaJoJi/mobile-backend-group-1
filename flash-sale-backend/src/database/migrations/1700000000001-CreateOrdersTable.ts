import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrdersTable1700000000001 implements MigrationInterface {
  name = 'CreateOrdersTable1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`
      CREATE TABLE "orders" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" varchar(50) NOT NULL,
        "productId" varchar(50) NOT NULL,
        "status" varchar(20) NOT NULL,
        "failureReason" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_orders" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_orders_user_product" UNIQUE ("userId", "productId")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "orders"`);
  }
}