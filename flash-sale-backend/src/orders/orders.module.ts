import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { Order } from './entities/order.entity';
import { Product } from '../products/entities/product.entity';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrdersProcessor } from './orders.processor';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, Product]),
    BullModule.registerQueue({ name: 'orders' }),
    AuthModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersProcessor],
})
export class OrdersModule {}