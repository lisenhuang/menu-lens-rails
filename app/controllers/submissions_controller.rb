class SubmissionsController < ApiController
  def verify
    ready!
    rate("verify",12,3600)
    token,result=Submissions.verify(body(6000),client_ip,city)
    response.set_cookie("ml_session",cookie_options("/api",86400).merge(value:token))
    response.set_cookie("ml_job",cookie_options("/api/jobs/#{result[:id]}",2592000).merge(value:token))
    render json:result
  end
  def places
    rate("places",24,600)
    q=Store.clean(body(2500)["query"],220,"Restaurant search")
    raise Problem.new(400,"Type a restaurant name to search.") if q.length<2
    render json:Places.lookup(q)
  end
end
