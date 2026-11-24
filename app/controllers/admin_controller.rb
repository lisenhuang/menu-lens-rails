class AdminController < ApiController
  before_action :authenticate, except: :login
  def login
    verifier=ENV["ADMIN_PIN_VERIFIER"].presence || raise(Problem.new(503,"Admin sign-in is unavailable."))
    rate("admin-login",10,900)
    pin,token=body(4096).values_at("pin","token")
    Providers.verify_person(token,client_ip,"admin_login")
    Store.capacity!("admin-pin-attempts",30,900_000)
    salt,digest=verifier.split(":",2)
    valid=pin.is_a?(String) && pin.match?(/\A\d{6}\z/) && salt&.match?(/\A[a-f0-9]{32}\z/) && digest&.match?(/\A[a-f0-9]{64}\z/)
    valid &&= ActiveSupport::SecurityUtils.secure_compare(OpenSSL::KDF.scrypt(pin,salt:[salt].pack("H*"),N:32768,r:8,p:1,length:32).unpack1("H*"),digest)
    raise Problem.new(401,"Sign-in failed. Check your PIN and try again.") unless valid
    value=SecureRandom.hex(32)
    Store.sql("INSERT INTO admin_sessions VALUES(?,?)",Store.sha(verifier+value),Store.now+14400000)
    response.set_cookie("ml_admin",cookie_options("/api/admin",14400).merge(value:value))
    render json:{ok:true}
  end
  def logout
    Store.sql("DELETE FROM admin_sessions WHERE id=?",@admin_id)
    response.set_cookie("ml_admin",cookie_options("/api/admin",0).merge(value:""))
    render json:{ok:true}
  end
  def settings
    current=Settings.current
    render json:{settings:current,imageModels:Settings::IMAGES,readingModels:Settings::READERS,outputUsdPerMillion:30,
      readingModel:current["readingModel"],readingEfforts:Settings::READERS.dig(current["readingModel"],"efforts"),
      balance:Store.first("SELECT cents,organization,checked FROM billing_snapshot WHERE id=1")}
  end
  def save = render(json:{settings:Settings.save(body(2048))})
  def history
    before=Integer(params.fetch(:before,"9007199254740991"),exception:false)
    raise Problem.new(400,"Invalid history page.") unless before && before.between?(1,9007199254740991)
    render json:GenerationHistory.list(before)
  end
  def calls = render(json:{calls:Store.sql("SELECT started,kind,label,model,level,ip,state,usd,basis FROM generation_calls WHERE run_id=? ORDER BY seq",params[:id])})
  private
  def authenticate
    value=cookie_token("ml_admin")
    @admin_id=Store.sha(ENV["ADMIN_PIN_VERIFIER"]+value) if value && ENV["ADMIN_PIN_VERIFIER"].present?
    raise Problem.new(401,"Sign in to manage generation settings.") unless @admin_id && Store.first("SELECT 1 FROM admin_sessions WHERE id=? AND expires>?",@admin_id,Store.now)
  end
end
