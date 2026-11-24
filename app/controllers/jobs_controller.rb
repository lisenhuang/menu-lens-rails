class JobsController < ApiController
  before_action :authorize_write, if: -> { request.post? }
  def show = render(json:JobStatus.fetch(params[:id],job_owner))
  def review
    row=review_draft
    render json:JSON.parse(row.result).merge("photoCount"=>row.page_keys.size)
  end
  def photo
    key=review_draft.page_keys[params[:position].to_i] || raise(ActiveRecord::RecordNotFound)
    send_data Objects.request(key),type:"image/jpeg",disposition:"inline"
  end
  def confirm_address
    Submissions.confirm(@owner,body(2048))
    render json:{ok:true}
  end
  def upload
    upload_pages unless Menu.exists?(@id)
    render json:{id:@id},status:202
  end
  def legacy_read
    upload_pages
    unless @session.info["autoPublish"]
      300.times do
        row=Draft.find_by(id:@id)
        return render(json:JSON.parse(row.result)) if row&.state=="review"
        raise Problem.new(422,row.error) if row&.error
        break unless row
        sleep 0.5
      end
    end
    render json:{id:@id},status:202
  end
  def publish
    Store.transaction do
      unless Menu.exists?(@id)
        rate("publish",5,86400)
        b=body
        draft=Draft.find_by(id:@id,owner:@owner,state:"review")
        raise Problem.new(403,"Read the menu before publishing.") unless draft && (b["reviewed"]==true || b["useTranscription"]==true)
        Submissions.image_capacity!
        Submissions.enqueue(draft,b["useTranscription"]==true ? JSON.parse(draft.result) : b,client_ip)
        GenerationHistory.city(@id,client_ip,city)
      end
    end
    render json:{id:@id},status:202
  end
  def retry_read
    Submissions.retry_read(@id,@session,body(1024)["attempt"],client_ip,city)
    render json:{id:@id},status:202
  end
  define_method(:retry) do
    rate("retry",6,600)
    Store.transaction do
      Submissions.image_capacity!
      n=Menu.where(id:@id,owner:@owner,state:"error").where("attempts<3").update_all("state='queued',attempts=attempts+1")
      raise Problem.new(409,"This menu cannot be retried right now.") unless n==1
      GenerationHistory.image_requester(@id,client_ip)
      GenerationHistory.city(@id,client_ip,city)
    end
    render json:{ok:true},status:202
  end
  private
  def authorize_write
    ready!
    @owner=params[:id] ? job_owner : session_owner&.id
    raise Problem.new(403,"Open this submission in the browser used to upload.") unless @owner
    @id=params[:id] || Store.submission_id(@owner)
    raise Problem.new(403,"Open this submission in the browser used to upload.") unless @id==Store.submission_id(@owner) || Menu.exists?(id:@id,owner:@owner)
    @session=SubmissionSession.valid.find_by(id:@owner)
    raise Problem.new(403,"Your upload has expired.") unless @session || (Menu.exists?(@id) && %w[retry upload publish].include?(action_name))
  end
  def upload_pages
    rate("read",9,86400)
    Submissions.upload(@id,@session,body(16_000_000),client_ip,city) { rate("publish",5,86400) }
  end
  def review_draft
    draft=JobStatus.private_draft(params[:id],job_owner)
    raise ActiveRecord::RecordNotFound unless draft&.state=="review"
    draft
  end
end
