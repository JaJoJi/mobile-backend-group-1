import {
  Entity,
  PrimaryColumn,
  Column,
  VersionColumn,
} from 'typeorm';

@Entity('products')
export class Product {
  @PrimaryColumn({ type: 'varchar', length: 50 })
  productId: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number;

  @Column({ type: 'int' })
  availableStock: number;

  @Column({ type: 'int' })
  remainingStock: number;

  @Column({ type: 'boolean' })
  isFlashSaleActive: boolean;

  @VersionColumn({ default: 1 })
  version: number;
}