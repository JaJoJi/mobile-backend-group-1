import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const auth: string | undefined = req.headers['authorization'];
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        status: 'error',
        message: 'Missing or malformed Authorization header',
      });
    }
    const token = auth.slice(7).trim();
    try {
      const payload = this.jwt.verify<{ sub: string }>(token);
      req.user = { userId: payload.sub };
      return true;
    } catch {
      throw new UnauthorizedException({
        status: 'error',
        message: 'Invalid or expired token',
      });
    }
  }
}