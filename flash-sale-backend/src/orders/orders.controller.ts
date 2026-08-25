import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrdersService } from './orders.service';

@Controller('api/v1/orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @HttpCode(202)
  async create(
    @CurrentUser('userId') userId: string,
    @Body() dto: CreateOrderDto,
    @Req() req: Request,
  ) {
    const traceId = (req as Request & { id?: string }).id;
    return this.ordersService.create(userId, dto.productId, traceId);
  }
}