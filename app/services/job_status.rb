module JobStatus
  module_function
  def private_draft(id,owner)
    return unless owner
    Draft.joins(:submission_session).where("sessions.expires>?",Store.now).find_by(id:id,owner:owner)
  end
  def fetch(id,owner)
    if (menu=Menu.find_by(id:id))
      return menu.status(owner)
    end
    draft=private_draft(id,owner) || raise(Problem.new(404,"This private submission is unavailable."))
    s=draft.submission_session
    r=s.info.fetch("restaurant")
    reading=draft.state=="reading" && !!Store.first("SELECT 1 FROM generation_calls WHERE run_id=? AND kind='read' AND state='running'",id)
    paused = draft.state == "read_paused"
    {id:id,name:r["name"],restaurant:r,date:s.info["date"],state:paused ? "read_error" : draft.state,error:draft.error,pageCount:draft.page_keys.size,
      transcribing:reading,readAttempt:s.reads,expires:s.expires,canRetryRead:draft.page_keys.any? && (paused || (draft.state=="read_error" && s.reads<3))}
  end
end
