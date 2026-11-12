export type StageType = 'applied' | 'initial' | 'test' | 'interview' | 'shortlisted' | 'hired' | 'rejected';
export type ApplicationStatus = 'active' | 'hired' | 'rejected';
export type InterviewMode = 'video' | 'in_person' | 'phone';
export type InterviewStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show';
export type Recommendation = 'strong_yes' | 'yes' | 'no' | 'strong_no';

export const STAGE_TYPE_LABEL: Record<StageType, string> = {
  applied: 'Applied', initial: 'Initial', test: 'Test', interview: 'Interview',
  shortlisted: 'Shortlisted', hired: 'Hired', rejected: 'Rejected',
};
/** Types a user can pick for a stage they add or retype (the three fixed types are not offered). */
export const FREE_STAGE_TYPES: StageType[] = ['initial', 'test', 'interview', 'shortlisted'];

export interface Paged<T> { items: T[]; total: number; page: number; limit: number }

export interface RecruitmentSummary {
  id: number; title: string; slug: string; status: 'open' | 'closed'; isPublished: boolean;
  startDate: string; endDate: string | null; totalVacancies: number; filled: number; applicationCount: number; updatedAt: string;
}
export interface Stage { id: number; name: string; stageType: StageType; sequence: number; count: number }
export interface VacancyLine { id: number; jobPositionId: number; title: string; department: string | null; vacancies: number; applied: number; filled: number }
export interface PersonRef { id: number; name: string; code: string; jobTitle: string | null }
export interface Recruitment extends RecruitmentSummary {
  description: string; optionalResume: boolean; optionalPhoto: boolean; skills: string[];
  surveyTemplate: { id: number; name: string } | null; publicPath: string;
  managers: PersonRef[]; vacancies: VacancyLine[]; stages: Stage[]; createdAt: string;
}

export interface RecruitmentBody {
  title: string; description: string; managerIds: number[]; startDate: string; endDate: string | null;
  surveyTemplateId: number | null; skills: string[]; isPublished: boolean; optionalResume: boolean; optionalPhoto: boolean;
  vacancies: { jobPositionId: number; vacancies: number }[];
  stages: { id?: number; name: string; stageType: StageType }[];
}

export interface ApplicationRow {
  id: number; reference: string;
  candidate: { id: number; name: string; email: string; phone: string | null; currentTitle: string | null; experienceYears: number | null };
  recruitment: { id: number; title: string };
  stage: { id: number; name: string; type: StageType };
  position: { id: number; title: string } | null;
  status: ApplicationStatus; rating: number | null; source: string;
  appliedAt: string; stageChangedAt: string; hasResume: boolean; hasPhoto: boolean; photoUrl: string | null;
  nextInterviewAt: string | null; updatedAt: string;
}
export interface ApplicationDetail extends ApplicationRow {
  coverLetter: string | null;
  answers: { questionId: string; label: string; type: string; value: string | number | boolean }[];
  rejection: { reason: string | null; note: string | null } | null;
  resumeUrl: string | null;
  history: { id: number; from: string | null; to: string; note: string | null; by: string | null; at: string }[];
  notes: { id: number; body: string; by: string | null; at: string }[];
  interviews: { id: number; title: string; startsAt: string; endsAt: string; mode: InterviewMode; status: InterviewStatus }[];
}

export interface CandidateRow {
  id: number; fullName: string; email: string; phone: string | null; currentCompany: string | null; currentTitle: string | null;
  experienceYears: number | null; location: string | null; linkedinUrl: string | null; source: string;
  createdAt: string; updatedAt: string; applicationCount: number; activeCount: number; applicationsText: string | null;
}
export interface CandidateDetail extends Omit<CandidateRow, 'applicationCount' | 'activeCount' | 'applicationsText'> {
  applications: ApplicationRow[];
  documents: { id: number; kind: 'resume' | 'photo'; fileName: string; contentType: string; byteSize: number; uploadedAt: string; url: string }[];
}

export interface Interview {
  id: number; title: string; startsAt: string; endsAt: string; mode: InterviewMode; location: string | null;
  meetingLink: string | null; notes: string | null; status: InterviewStatus; cancelReason: string | null;
  application: {
    id: number; reference: string; status: string; stageName: string;
    candidate: { id: number; name: string; email: string }; recruitment: { id: number; title: string };
  };
  interviewers: { id: number; name: string; jobTitle: string | null; hasFeedback: boolean }[];
  updatedAt: string;
}
export interface FeedbackEntry {
  id: number; employeeId: number; by: string; rating: number; recommendation: Recommendation;
  strengths: string | null; concerns: string | null; comments: string | null; submittedAt: string;
}
export interface InterviewDetail extends Interview {
  feedback: FeedbackEntry[]; myFeedback: FeedbackEntry | null; canGiveFeedback: boolean;
}
export interface InterviewBody {
  applicationId?: number; title?: string; startsAt?: string; endsAt?: string; mode?: InterviewMode;
  location?: string | null; meetingLink?: string | null; notes?: string | null; interviewerIds?: number[];
  allowConflicts?: boolean; updatedAt?: string;
}
export interface BusyConflict { employeeId: number; employee: string; interviewId: number; title: string; startsAt: string; endsAt: string }

export interface EmployeeOption { id: number; name: string; code: string; jobTitle: string | null; department: string | null }

export interface ConfigBase { id: number; name: string; description: string | null; isActive: boolean; createdAt: string; updatedAt: string }
export interface JobPosition extends ConfigBase { title: string; departmentId: number | null; department: string | null; openRecruitments: number }
export interface RejectionReason extends ConfigBase { /* name + description */ }
export type QuestionType = 'text' | 'textarea' | 'yes_no' | 'select' | 'number';
export interface SurveyQuestion { id?: string; label: string; type: QuestionType; required: boolean; options: string[] }
export interface SurveyTemplate extends ConfigBase { questions: Required<SurveyQuestion>[] }
export interface RecruitmentSettings {
  careersEnabled: boolean; careersHeadline: string | null; careersIntro: string | null;
  confirmationMessage: string | null; privacyNoticeUrl: string | null; updatedAt: string | null;
}

// ------------------------------------------------------------------ public ---
export interface PublicOrg { name: string; slug: string; logoUrl: string | null; headline?: string | null; intro?: string | null; privacyNoticeUrl?: string | null }
export interface PublicJobCard {
  slug: string; title: string; excerpt: string; skills: string[]; startDate: string; endDate: string | null;
  departments: string[]; openPlaces: number; positionTitles: string[];
}
export interface PublicJobList { organization: PublicOrg; departments: string[]; jobs: PublicJobCard[] }
export interface PublicQuestion { id: string; label: string; type: QuestionType; required: boolean; options: string[] }
export interface PublicJob {
  organization: PublicOrg;
  job: {
    slug: string; title: string; description: string; skills: string[]; startDate: string; endDate: string | null;
    positions: { id: number; title: string; department: string | null; openPlaces: number }[];
    resumeRequired: boolean; photoAllowed: boolean; questions: PublicQuestion[];
  };
}
export interface UploadedFile { id: number; claimToken: string; fileName: string; contentType: string; byteSize: number }
