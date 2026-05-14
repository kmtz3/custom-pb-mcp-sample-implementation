export type PBFieldValue =
  | string
  | number
  | boolean
  | { name: string }
  | { email: string }
  | Array<{ name: string }>
  | Array<{ email: string }>
  | null;

export interface PBEntity {
  id: string;
  type: string;
  fields: Record<string, PBFieldValue>;
  createdAt?: string;
  updatedAt?: string;
  links?: { html?: string; next?: string };
  metadata?: {
    source?: {
      system: string;
      recordId: string;
      url?: string;
    };
  };
}

export interface PBNote {
  id: string;
  fields: {
    name?: string;
    content?: string;
    tags?: Array<{ id?: string; name: string }>;
    owner?: { email: string } | null;
    archived?: boolean;
    [key: string]: unknown;
  };
  metadata?: {
    source?: {
      system: string;
      recordId: string;
      url?: string;
    };
  };
}

export interface PBNoteRelationship {
  type: string;
  target: {
    id: string;
    type: string;
  };
}

export interface PBMember {
  id: string;
  fields?: {
    name?: string;
    email?: string;
    role?: string;
    disabled?: boolean;
    invitationPending?: boolean;
  };
}

export interface PBTeam {
  id: string;
  fields?: {
    name?: string;
    handle?: string;
    description?: string;
  };
}

export interface PBFieldValueDefinition {
  id: string;
  fields: {
    name: string;
    color?: string;
  };
}

export interface PBEntityConfigField {
  id: string;
  name: string;
  schema?: {
    type?: string;
    format?: string;
    [key: string]: unknown;
  };
  constraints?: {
    maxLength?: number;
    required?: boolean;
    [key: string]: unknown;
  };
}

export interface PBEntityConfiguration {
  type: string;
  fields: Record<string, PBEntityConfigField>;
}

export interface PBMemberActivityRecord {
  memberId: string;
  date: string;
  activeFlag: boolean;
  boardCreatedCount: number;
  boardOpenedCount: number;
  featureCreatedCount: number;
  subfeatureCreatedCount: number;
  componentCreatedCount: number;
  productCreatedCount: number;
  noteCreatedCount: number;
  noteStateChangedCount: number;
  insightCreatedCount: number;
  gridBoardCreatedCount: number;
  timelineBoardCreatedCount: number;
  insightsBoardCreatedCount: number;
  documentBoardCreatedCount: number;
  columnBoardCreatedCount: number;
  gridBoardOpenedCount: number;
  timelineBoardOpenedCount: number;
  insightsBoardOpenedCount: number;
  documentBoardOpenedCount: number;
  columnBoardOpenedCount: number;
}

export interface PBPage<T> {
  data: T[];
  links?: {
    next?: string | null;
  };
}
