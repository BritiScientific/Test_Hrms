import { api, qs } from '@/services/api-client';
import type {
  ApplicationDetail, ApplicationRow, CandidateDetail, CandidateRow, EmployeeOption, FeedbackEntry, Interview, InterviewBody,
  InterviewDetail, JobPosition, Paged, PublicJob, PublicJobList, Recruitment, RecruitmentBody, RecruitmentSettings,
  RecruitmentSummary, RejectionReason, SurveyTemplate, UploadedFile,
} from './types';

const R = '/recruitment';

function config<T>(path: string) {
  return {
    list: (q: Record<string, string | number | undefined>) => api.get<Paged<T>>(`${R}/config/${path}${qs(q)}`),
    create: (body: Record<string, unknown>) => api.post<T>(`${R}/config/${path}`, body),
    update: (id: number, body: Record<string, unknown>) => api.patch<T>(`${R}/config/${path}/${id}`, body),
    setStatus: (id: number, body: { isActive: boolean; updatedAt: string }) => api.patch<T>(`${R}/config/${path}/${id}/status`, body),
  };
}
export type ConfigApi<T> = ReturnType<typeof config<T>>;

export const recruitmentApi = {
  recruitments: {
    list: (q: { status?: string; search?: string } = {}) => api.get<Paged<RecruitmentSummary>>(`${R}/recruitments${qs({ limit: 100, ...q })}`),
    get: (id: number) => api.get<Recruitment>(`${R}/recruitments/${id}`),
    create: (body: RecruitmentBody) => api.post<Recruitment>(`${R}/recruitments`, body),
    update: (id: number, body: Partial<RecruitmentBody> & { updatedAt: string }) => api.patch<Recruitment>(`${R}/recruitments/${id}`, body),
    setStatus: (id: number, body: { status: 'open' | 'closed'; updatedAt: string }) => api.patch<Recruitment>(`${R}/recruitments/${id}/status`, body),
    addCandidate: (id: number, body: Record<string, unknown>) => api.post<ApplicationDetail>(`${R}/recruitments/${id}/applications`, body),
  },
  applications: {
    list: (q: Record<string, string | number | undefined>) => api.get<Paged<ApplicationRow>>(`${R}/applications${qs(q)}`),
    get: (id: number) => api.get<ApplicationDetail>(`${R}/applications/${id}`),
    move: (id: number, body: { stageId: number; updatedAt: string; note?: string | null; rejectionReasonId?: number | null; rejectionNote?: string | null }) =>
      api.post<ApplicationDetail>(`${R}/applications/${id}/move`, body),
    bulkMove: (body: { ids: number[]; stageId: number; rejectionReasonId?: number | null; rejectionNote?: string | null }) =>
      api.post<{ moved: number[]; failed: { id: number; code: string; message: string }[] }>(`${R}/applications/bulk-move`, body),
    patch: (id: number, body: { rating?: number | null; jobPositionId?: number | null; updatedAt: string }) => api.patch<ApplicationDetail>(`${R}/applications/${id}`, body),
    addNote: (id: number, body: string) => api.post<ApplicationDetail>(`${R}/applications/${id}/notes`, { body }),
  },
  candidates: {
    list: (q: Record<string, string | number | undefined>) => api.get<Paged<CandidateRow>>(`${R}/candidates${qs(q)}`),
    get: (id: number) => api.get<CandidateDetail>(`${R}/candidates/${id}`),
    update: (id: number, body: Record<string, unknown>) => api.patch<CandidateDetail>(`${R}/candidates/${id}`, body),
  },
  upload: (kind: 'resume' | 'photo', file: File) =>
    api.post<UploadedFile>(`${R}/documents${qs({ kind, fileName: file.name })}`, undefined, { raw: file, contentType: file.type || 'application/octet-stream' }),
  interviews: {
    list: (q: Record<string, string | number | boolean | undefined>) => api.get<Paged<Interview>>(`${R}/interviews${qs(q)}`),
    get: (id: number) => api.get<InterviewDetail>(`${R}/interviews/${id}`),
    create: (body: InterviewBody) => api.post<InterviewDetail>(`${R}/interviews`, body),
    update: (id: number, body: InterviewBody) => api.patch<InterviewDetail>(`${R}/interviews/${id}`, body),
    setStatus: (id: number, body: { status: 'completed' | 'cancelled' | 'no_show'; reason?: string | null; updatedAt: string }) =>
      api.patch<InterviewDetail>(`${R}/interviews/${id}/status`, body),
    feedback: (id: number, body: Pick<FeedbackEntry, 'rating' | 'recommendation'> & { strengths?: string | null; concerns?: string | null; comments?: string | null }) =>
      api.put<InterviewDetail>(`${R}/interviews/${id}/feedback`, body),
  },
  lookups: {
    employees: (q: { search?: string; ids?: string } = {}) => api.get<EmployeeOption[]>(`${R}/lookups/employees${qs(q)}`),
    jobPositions: () => api.get<JobPosition[]>(`${R}/lookups/job-positions`),
    surveyTemplates: () => api.get<SurveyTemplate[]>(`${R}/lookups/survey-templates`),
    rejectionReasons: () => api.get<RejectionReason[]>(`${R}/lookups/rejection-reasons`),
    departments: () => api.get<{ id: number; name: string }[]>(`${R}/lookups/departments`),
  },
  config: {
    jobPositions: config<JobPosition>('job-positions'),
    surveyTemplates: config<SurveyTemplate>('survey-templates'),
    rejectionReasons: config<RejectionReason>('rejection-reasons'),
    settings: () => api.get<RecruitmentSettings>(`${R}/config/settings`),
    saveSettings: (body: Omit<RecruitmentSettings, 'updatedAt'>) => api.put<RecruitmentSettings>(`${R}/config/settings`, body),
  },
};

/** Careers site (no session). */
export const careersApi = {
  list: (q: { org?: string; search?: string; department?: string }) => api.get<PublicJobList>(`/public/careers${qs(q)}`),
  job: (slug: string) => api.get<PublicJob>(`/public/careers/jobs/${encodeURIComponent(slug)}`),
  upload: (slug: string, kind: 'resume' | 'photo', file: File) =>
    api.post<UploadedFile>(`/public/careers/jobs/${encodeURIComponent(slug)}/uploads${qs({ kind, fileName: file.name })}`, undefined,
      { raw: file, contentType: file.type || 'application/octet-stream' }),
  apply: (slug: string, body: Record<string, unknown>) =>
    api.post<{ reference: string; jobTitle: string; message: string | null }>(`/public/careers/jobs/${encodeURIComponent(slug)}/applications`, body),
};
