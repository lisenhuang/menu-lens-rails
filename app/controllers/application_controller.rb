class ApplicationController < ActionController::Base
  skip_forgery_protection
  before_action { response.headers["Cache-Control"]="private, no-store" }
  rescue_from Problem, with: :problem
  rescue_from ActiveRecord::RecordNotFound do
    problem(Problem.new(404,"This page could not be found."))
  end
  private
  def problem(error)
    render json:{error:error.message},status:error.status
  end
  def client_ip = ENV["TRUST_CLOUDFLARE"]=="1" ? request.headers["CF-Connecting-IP"].to_s : request.get_header("REMOTE_ADDR")
  def city = ENV["TRUST_CLOUDFLARE"]=="1" ? request.headers["CF-IPCity"].to_s.dup.force_encoding("UTF-8") : nil
  def public_origin = ENV["PUBLIC_ORIGIN"].presence || request.base_url
  def cookie_token(key)
    value=request.cookies[key]
    value if value.is_a?(String) && value.match?(/\A[a-f0-9]{64}\z/)
  end
  def session_owner
    t=cookie_token("ml_session")
    t && SubmissionSession.valid.find_by(id:Store.sha(t))
  end
  def job_owner
    t=cookie_token("ml_job")
    t ? Store.sha(t) : session_owner&.id
  end
  def cookie_options(path,age)
    {path:path,max_age:age,httponly:true,same_site: :strict,secure:public_origin.start_with?("https:")}
  end
end
