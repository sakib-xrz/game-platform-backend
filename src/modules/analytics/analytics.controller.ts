import { Request, Response } from 'express';
import httpStatus from 'http-status';
import catchAsync from '@/utils/catch-async';
import sendResponse from '@/utils/send-response';
import AnalyticsService from './analytics.services';
import type {
  AnalyticsOverviewQuery,
  AnalyticsUserDetailQuery,
  AnalyticsUsersQuery,
} from './analytics.validation';

const getOverview = catchAsync(async (req: Request, res: Response) => {
  const data = await AnalyticsService.getOverview(req.query as unknown as AnalyticsOverviewQuery);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Analytics overview fetched',
    data,
  });
});

const listUsers = catchAsync(async (req: Request, res: Response) => {
  const result = await AnalyticsService.listUsers(req.query as unknown as AnalyticsUsersQuery);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Analytics users fetched',
    meta: { page: result.page, limit: result.limit, total: result.total },
    data: result.items,
  });
});

const getUserDetail = catchAsync(async (req: Request, res: Response) => {
  const data = await AnalyticsService.getUserDetail(
    String(req.params.user_id),
    req.query as unknown as AnalyticsUserDetailQuery,
  );
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: 'Analytics user detail fetched',
    data,
  });
});

export default { getOverview, listUsers, getUserDetail };
