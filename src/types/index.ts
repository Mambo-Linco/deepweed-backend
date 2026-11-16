export interface User {
  id: string
  email: string
  first_name: string
  last_name: string
  role: 'farmer' | 'admin'
  farm_location: string | null
  primary_crop: string | null
  created_at: string
  updated_at: string
}

export interface WeedScan {
  id: string
  user_id: string
  weed_name: string
  confidence: number
  crop_type: string
  image_url: string | null
  recommendations: string[] | null
  top3: { class_name: string; confidence: number }[] | null
  created_at: string
}

export interface Herbicide {
  id: string
  weed_name: string
  herbicide_name: string
  active_ingredient: string | null
  dosage: string
  application_method: string | null
  application_timing: string | null
  crop: string | null
  mode_of_action: string | null
  pre_harvest_interval: string | null
  safety_notes: string | null
  created_by: string | null
  updated_at: string
}

export interface Feedback {
  id: string
  user_id: string
  message: string
  status: 'pending' | 'reviewed' | 'resolved'
  admin_note: string | null
  reviewed_by: string | null
  is_correct: boolean | null
  scan_id: string | null
  corrected_weed_name: string | null
  replied_at: string | null
  reply_seen_at: string | null
  created_at: string
  updated_at: string
}

export interface JwtPayload {
  userId: string
  email: string
  role: 'farmer' | 'admin'
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload
    }
  }
}
