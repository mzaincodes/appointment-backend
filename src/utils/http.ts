import type { Response } from 'express';
import type { ApiSuccess, Paginated } from '../types';

/**
 * Response helpers.
 *
 * Every endpoint answers with the same envelope, so the frontend has exactly
 * one shape to unwrap and one place to look for an error message.
 *
 *   success: { "success": true,  "data": … }
 *   failure: { "success": false, "message": …, "code": … }
 *
 * The failure half is produced centrally by the error middleware — controllers
 * never build one by hand, they throw an AppError instead.
 */

export function ok<T>(res: Response, data: T, message?: string): Response {
  const body: ApiSuccess<T> = { success: true, data };
  if (message) body.message = message;
  return res.status(200).json(body);
}

export function created<T>(res: Response, data: T, message?: string): Response {
  const body: ApiSuccess<T> = { success: true, data };
  if (message) body.message = message;
  return res.status(201).json(body);
}

export function noContent(res: Response): Response {
  return res.status(204).send();
}

export function paginated<T>(
  res: Response,
  items: T[],
  { page, pageSize, total }: { page: number; pageSize: number; total: number },
): Response {
  const body: ApiSuccess<Paginated<T>> = {
    success: true,
    data: {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
  return res.status(200).json(body);
}
