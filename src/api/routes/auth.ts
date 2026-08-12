import { Router, Request, Response, NextFunction } from 'express';
import { userRepository } from '../../infrastructure/repositories';
import { authService } from '../../domain/auth-service';
import { BusinessError } from '../../domain/entities';
import { authenticateAdmin } from '../middleware/auth';

const router = Router();

interface LoginDto {
  email: string;
  password: string;
}

router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password }: LoginDto = req.body;

    if (!email || !password) {
      throw new BusinessError('INVALID_DATA', 'Email y contraseña son requeridos.');
    }

    const user = await userRepository.findByEmail(email);

    if (!user) {
      throw new BusinessError('INVALID_CREDENTIALS', 'Credenciales inválidas.');
    }

    const isValidPassword = await authService.comparePassword(password, user.password);
    if (!isValidPassword) {
      throw new BusinessError('INVALID_CREDENTIALS', 'Credenciales inválidas.');
    }

    const accessToken = authService.generateAccessToken(user);
    const refreshToken = authService.generateRefreshToken(user);

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw new BusinessError('INVALID_DATA', 'Refresh token es requerido.');
    }

    const payload = authService.verifyRefreshToken(refreshToken);

    const user = await userRepository.getById(payload.userId);
    if (!user) {
      throw new BusinessError('USER_NOT_FOUND', 'Usuario no encontrado.');
    }

    const newAccessToken = authService.generateAccessToken(user);
    const newRefreshToken = authService.generateRefreshToken(user);

    res.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as any).user?.userId;

    const user = await userRepository.getById(userId);
    if (!user) {
      throw new BusinessError('USER_NOT_FOUND', 'Usuario no encontrado.');
    }

    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        createdAt: user.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
