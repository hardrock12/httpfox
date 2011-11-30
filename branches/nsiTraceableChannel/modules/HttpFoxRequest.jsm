var EXPORTED_SYMBOLS = [
	"HttpFoxRequest"
];

// standard shortcuts
const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

function HttpFoxRequest(requestStore, service)
{
	Cu["import"]("resource://httpfox/Utils.jsm");
	Cu["import"]("resource://httpfox/HttpFoxDataHelper.jsm");
	
	this.RequestStore = requestStore;
	this.Service = service;
	
	// init arrays
	this.TreeIndex = [];
	this.ContentData = [];
};

HttpFoxRequest.prototype =
{
	// Properties
	Service: null,
	HttpChannel: null,
	ResponseStreamListener: null,
	RequestStore: null,
	OriginalCallback: null,

	IsFinished: false,
	IsComplete: true,
	HasContent: true,
	IsAborted: false,
	IsFromCache: false,
	IsRedirected: false,
	IsNetwork: false,
	HasReceivedResponseHeaders: false,
	HasPostBodyBeenSent: false,
	
	// helpers
	IsResponseStopped: false,
	IsHttpTransactionClosed: false,

	// request info types
	RequestHeaders: null,
	ResponseHeaders: null,
	
	PostDataHeaders: null,
	PostData: null,
	PostDataParameters: null,
	PostDataMIMEParts: null,
	PostDataMIMEBoundary: null,
	IsPostDataMIME: null,
	PostDataContentLength: null,
	IsPostDataTooBig: false,
	
	QueryString: null,
	QueryStringParameters: null,
	
	CookiesSent: null,
	CookiesReceived: null,

	// httpchannel infos
	Status: null,
	Url: null,
	URIPath: null,
	URIScheme: null,
	RequestMethod: null,
	IsBackground: false,
	ContentType: null,
	ContentCharset: null,
	ContentLength: null,
	RequestSucceeded: null,
	ResponseStatus: null,
	ResponseStatusText: null,
	EntityId: null,
	RequestProtocolVersion: null,
	ResponseProtocolVersion: null,

	// timing
	Duration: null,
	Timestamp_StartNet: null,
	Timestamp_StartJs: null,
	Timestamp_EndNet: null,
	Timestamp_EndJs: null,
	Timestamp_PostSent: null,
	Timestamp_ResponseStarted: null,
	Timestamp_ResponseHeadersComplete: null,
	
	// size
	RequestHeaderSize: null,
	ResponseHeaderSize: null,
	ContentSize: null,
	ResponseSize: null,
	ContentSizeFromNet: null,
	ContentSizeFromNetMax: null,
	BytesSent: null,
	BytesSentMax: null,
	
	// response
	ContentText: "",
	ContentData: null,

	Log: "",
	
	TreeIndex: null,
	//TreeIndex: null,

	AddLog: function(text)
	{
		this.Log += HFU.formatTime(new Date()) + ": " + text + "\n";
	},

	calculateRequestDuration: function()
	{
		if (this.Timestamp_StartNet && this.Timestamp_EndNet) 
		{
			this.Duration = HFU.formatTimeDifference(this.Timestamp_StartNet, this.Timestamp_EndNet);
			return;
		}
		
		this.Duration = HFU.formatTimeDifference(this.Timestamp_StartJs, this.Timestamp_EndJs);
	},

	isReadyToFinish: function()
	{
		if (this.Timestamp_EndJs != null) 
		{
			if (this.IsFromCache)
			{
				return true;
			}
			
			if (this.IsAborted) 
			{
				return true;
			}

			if (this.Timestamp_EndNet != null)
			{
				return true;
			}
		}
		
		return false;
	},

	isReadyToComplete: function ()
	{
		if (!this.HasContent)
		{
			return true;
		}
		
		if (this.IsAborted)
		{
			return true;
		}
				
		if (this.IsFromCache && this.IsResponseStopped)
		{
			return true;
		}
					
		if (this.IsHttpTransactionClosed && this.IsResponseStopped)
		{
			return true;
		}

		return false;
	},
	
	finishIfReady: function ()
	{
		if (this.isReadyToFinish())
		{
			// mark request as finshed. processing not yet stopped though.
			this.finish();
			
			// check if request processing is complete. stop listening to events.
			if (this.isReadyToComplete())
			{
				this.complete();
			}
		}
	},
	
	complete: function ()
	{
		this.IsComplete = true;
		this.AddLog("complete");
		this.RequestStore.removeRequestFromPendingRequests(this);
		this.freeResources();
	},
	
	finish: function ()
	{
		this.calculateRequestDuration();
		this.IsFinished = true;
		this.Status = this.HttpChannel.status;
		this.AddLog("finished");

		//TODO: check for aborted httpchannel status. here?
		// check redirect
		if (this.Status && this.Status == HttpFoxNsResultErrors.NS_BINDING_REDIRECTED) 
		{
			this.IsRedirected = true;
		}
		
		// update GUI (event...)
		this.Service.requestUpdated(this);
	},
	
	freeResources: function () 
	{
		// free notificationcallbacks. put back to original callback
		if (this.HttpChannel.notificationCallbacks && 
			this.OriginalCallback)
		{
			this.HttpChannel.notificationCallbacks = this.OriginalCallback;
			this.OriginalCallback = null;
		}
		
		this.HttpChannel = null;
	},

	checkHttpChannelStatus: function (timestamp)
	{
		if (this.isHttpChannelAborted())
		{
			// aborted
			this.setAborted(timestamp);
			return true;
		}
		else if (this.isHttpChannelRedirected())
		{
			// redirected
			this.setRedirected(timestamp);
			return true;
		}

		return false;
	},
	
	isHttpChannelAborted: function () 
	{
		if (this.HttpChannel.status == HttpFoxNsResultErrors.NS_BINDING_ABORTED)
		{
			return true;
		}
	},
	
	isHttpChannelRedirected: function () 
	{
		if (this.HttpChannel.status == HttpFoxNsResultErrors.NS_BINDING_REDIRECTED)
		{
			return true;
		}
	},
	
	setAborted: function(timestamp)
	{
		this.IsAborted = true;
		this.Timestamp_EndJs = timestamp;
		this.AddLog("SetAborted");
	},

	setRedirected: function(timestamp)
	{
		this.IsRedirected = true;
		this.Timestamp_EndJs = timestamp;
		this.AddLog("SetRedirected");
	},

	getBytesReceived: function ()
	{
		if (this.IsNetwork && this.HasReceivedResponseHeaders)
		{
			return this.ResponseHeaderSize + ((this.ContentSizeFromNet != null) ? this.ContentSizeFromNet : 0);
		}
		return 0;
	},
	
	getBytesReceivedMax: function ()
	{
		return (this.ContentSizeFromNetMax != null) ? (this.ResponseHeaderSize + this.ContentSizeFromNetMax) : null;
	},
	
	getResponseSize: function ()
	{
		if (this.IsRedirected)
		{
			return this.ResponseHeaderSize + this.ContentSizeFromNet;
		}
		
		return this.ResponseHeaderSize + this.ContentSize;
	},
	
	getBytesSent: function()
	{
		return this.RequestHeaderSize + this.BytesSent;
	},
	
	getBytesSentMax: function()
	{
		return this.RequestHeaderSize + this.PostDataContentLength;
	},
	
	////////////////
	hasErrorCode: function() 
	{
		if (this.Status && !this.IsRedirected)
		{
			return true;
		}
		
		return false;
	},
	
	isError : function()
	{
//		if (this.IsComplete && 
//			this.hasErrorCode() && 
//			!this.ResponseStatus)
		if (this.IsFinished && 
			this.hasErrorCode())
		{
			return true;
		}
		
		return false;
	},
	
	isHTTPS : function()
	{
		if (this.URIScheme == "https")
		{
			return true;
		}
		
		return false;
	},
	
	isCompressed: function ()
	{
		if (!this.IsNetwork)
		{
			return false;
		}
		
		if (!this.IsFinished)
		{
			// TODO: other ways to get compressing. content-encoding
			return false;
		}
		
		return (this.getResponseSize() != this.getBytesReceived());
	},
	
	isPostRequest: function()
	{
		if (this.RequestMethod == "POST")
		{
			return true;
		}

		return false;
	},
	
	getReceivedColumnString: function ()
	{
		if (this.IsAborted)
		{
			return "";
		}

		if (!this.HasReceivedResponseHeaders)
		{
			return "*";
		}
		
//		if (this.IsFromCache && this.IsNetwork)
//		{
//			return "(0)";
//		}
//		
//		if (request.ResponseStatus == 304)
//		{
//			return "(0)";
//		}
					
		if (!this.IsFinished)
		{
			// show loading body progress
			var bytesMax = this.getBytesReceivedMax();
			return HFU.humanizeSize(this.getBytesReceived(), 6) + "/" + ((bytesMax != null) ? HFU.humanizeSize(bytesMax, 6) : "*");
		}
		else
		{
			var bytesReceived = HFU.humanizeSize(this.getBytesReceived(), 6);
			if (this.isCompressed())
			{
				//bytesReceived = this.ResponseHeaderSize + ":" + this.ContentSizeFromNet + ":" + this.ContentSize + "*" + this.getResponseSize() + "*" + this.getBytesReceived();
				bytesReceived += " (" + HFU.humanizeSize(this.getResponseSize()) + ")";
			}
			return bytesReceived;
		}
	},
	
	getSentColumnString: function ()
	{
		if (this.HasPostBodyBeenSent || !this.isPostRequest())
		{
			// finished sending
			return HFU.humanizeSize(this.getBytesSentMax(), 6);
		}
		
		// not finished
		return HFU.humanizeSize(this.getBytesSent(), 6) + "/" + HFU.humanizeSize(this.getBytesSentMax(), 6);
	}
	
//	calculateRequestHeadersSize: function()
//	{
//		var byteString = "";
//		byteString += this.RequestMethod + " " + this.URIPath + " HTTP/" + this.RequestProtocolVersion + "\r\n";
//		
//		for (var i in this.RequestHeaders)
//		{
//			byteString += i + ": " + this.RequestHeaders[i] + "\r\n";
//		}
//		
//		for (var i in this.PostDataHeaders)
//		{
//			byteString += i + ": " + this.PostDataHeaders[i] + "\r\n";
//		}
//		
//		byteString += "\r\n";
//		
//		return byteString.length;
//	},
//	
//	calculateResponseHeadersSize: function()
//	{
//		var byteString = "";
//		byteString += "HTTP/" + this.ResponseProtocolVersion + " " + this.ResponseStatus + " " + this.ResponseStatusText + "\r\n";
//		
//		for (var i in this.ResponseHeaders)
//		{
//			byteString += i + ": " + this.RequestHeaders[i] + "\r\n";
//		}
//		
//		byteString += "\r\n";
//		
//		return byteString.length;
//	},
};