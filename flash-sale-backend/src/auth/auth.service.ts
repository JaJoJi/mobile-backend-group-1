import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  getToken(userId: string) {
    const accessToken = this.jwt.sign({ sub: userId });
    return { status: 'success', accessToken };
  }
}