export const getPagination = (page = 1, limit = 20) => {
  const safe_page = Math.max(1, page);
  const safe_limit = Math.min(100, Math.max(1, limit));
  return {
    page: safe_page,
    limit: safe_limit,
    skip: (safe_page - 1) * safe_limit,
  };
};
