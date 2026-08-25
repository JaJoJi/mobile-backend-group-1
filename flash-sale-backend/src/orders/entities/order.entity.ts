import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type OrderStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

@Entity('orders')
@Index('UQ_orders_user_product', ['userId', 'productId'], { unique: true })
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 50 })
  userId!: string;

  @Column({ type: 'varchar', length: 50 })
  productId!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: OrderStatus;

  @Column({ type: 'text', nullable: true })
  failureReason!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}