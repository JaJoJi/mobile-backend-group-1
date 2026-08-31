import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropVersionColumn1700000000002 implements MigrationInterface {
  name = 'DropVersionColumn1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pessimistic locking replaces optimistic version column; the column is no
    // longer referenced by the entity or any code path.
    await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "version"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "products" ADD COLUMN "version" integer NOT NULL DEFAULT 1`,
    );
  }
}