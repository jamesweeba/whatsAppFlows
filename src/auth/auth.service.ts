import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { hash, compare } from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service.js';
import { SignupDto } from './dto/signup.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { LoginThrottleService } from './login-throttle.service.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly throttle: LoginThrottleService,
  ) {}

  async signup(dto: SignupDto) {
    // Check if user already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existingUser) {
      throw new ConflictException('A user with this email already exists');
    }

    // Hash the password
    const hashedPassword = await hash(dto.password, 12);

    // Create the user
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password: hashedPassword,
        firstName: dto.firstName,
        lastName: dto.lastName,
      },
    });

    // Generate JWT token
    const token = await this.generateToken(user.id, user.email, user.role);

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        createdAt: user.createdAt,
      },
      accessToken: token,
    };
  }

  /** `ip` is the caller's address, for the per-IP limit on failed attempts. */
  async login(dto: LoginDto, ip?: string) {
    // Refuse while locked out, before even checking the password.
    this.throttle.assertAllowed(dto.email, ip);

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    // Same error, and a failure counted, whether the email or the password was wrong.
    const isPasswordValid = user ? await compare(dto.password, user.password) : false;
    if (!user || !isPasswordValid) {
      this.throttle.recordFailure(dto.email, ip);
      throw new UnauthorizedException('Invalid email or password');
    }
    this.throttle.recordSuccess(dto.email);

    // Generate JWT token
    const token = await this.generateToken(user.id, user.email, user.role);

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        createdAt: user.createdAt,
      },
      accessToken: token,
    };
  }

  private async generateToken(userId: string, email: string, role: UserRole): Promise<string> {
    const payload = { sub: userId, email, role };
    return this.jwtService.signAsync(payload);
  }
}
